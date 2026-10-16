// ---------------------------------------------------------------------------
// cloud/azure-backend.ts — Azure Blob Storage (block blobs)
// ---------------------------------------------------------------------------
//
// PARTS are staged blocks (Put Block) of the final blob, committed in order by
// Put Block List. Block ids are derived from the part (see checksums.ts), so
// there is no upload id to store and the part hashes come back from Get Block
// List. Each block is sent with Content-MD5, which Azure verifies (Azure has no
// SHA-256 check; the server verifies SHA-256 itself before staging).
//
// AUTH, in order: a connection string; an account URL with an account key; an
// account URL with a SAS token; an account URL alone → Microsoft Entra ID via
// DefaultAzureCredential (managed identity, workload identity, service
// principal, developer login). Direct transfer needs to SIGN per-block SAS
// URLs: with an account key (service SAS) or with Entra ID (user delegation
// SAS). A configured SAS token cannot sign new ones, so direct transfer is not
// available with it.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type * as AzureBlob from '@azure/storage-blob';
import type * as AzureIdentity from '@azure/identity';

import { UploadError } from '../../core/errors.js';
import type { CloudSessionRef } from '../../core/session.js';
import type { StorageAdapter, StoredObjectInfo } from '../adapter.js';
import { azureBlockId, compositeSha256, parseAzureBlockId } from './checksums.js';
import { loadOptional } from './load-optional.js';
import type { CloudBackend, CloudCommitResult, CloudPart, DirectPartRequest } from './types.js';

export interface AzureBackendConfig {
  readonly kind: 'azure_blob';
  readonly container: string;
  /** '' or ends with '/'. */
  readonly prefix: string;
  readonly connectionString?: string;
  readonly accountUrl?: string;
  readonly accountName?: string;
  readonly accountKey?: string;
  readonly sasToken?: string;
}

/** Service version sent with direct Put Block requests (the browser must send it unchanged). */
export const AZURE_DIRECT_API_VERSION = '2025-01-05';

type Sdk = typeof AzureBlob;

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number } | null)?.statusCode;
}

function toBuffer(data: Uint8Array | string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function collect(stream: NodeJS.ReadableStream | undefined): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/** Account name from a connection string, an explicit setting, or the URL. */
function accountNameOf(config: AzureBackendConfig, url: string): string {
  if (config.accountName) return config.accountName;
  const parsed = new URL(url);
  // Azurite / emulators use path-style URLs: http://127.0.0.1:10000/<account>
  if (/^[\d.]+$|^localhost$/.test(parsed.hostname)) return parsed.pathname.split('/').filter(Boolean)[0] ?? '';
  return parsed.hostname.split('.')[0] ?? '';
}

function connectionStringValue(cs: string, name: string): string | undefined {
  for (const part of cs.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim().toLowerCase() === name.toLowerCase()) return part.slice(eq + 1).trim();
  }
  return undefined;
}

class AzureControlStore implements StorageAdapter {
  constructor(
    private readonly container: AzureBlob.ContainerClient,
    private readonly prefix: string,
  ) {}

  private blob(key: string): AzureBlob.BlockBlobClient {
    return this.container.getBlockBlobClient(`${this.prefix}${key}`);
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    try {
      const props = await this.blob(key).getProperties();
      return { size: props.contentLength ?? 0, modifiedMs: props.lastModified?.getTime() ?? 0, isDirectory: false };
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    for await (const item of this.container.listBlobsFlat({ prefix: `${this.prefix}${key}/` })) {
      return { size: 0, modifiedMs: item.properties.lastModified?.getTime() ?? 0, isDirectory: true };
    }
    return null;
  }

  async list(dirKey: string): Promise<string[]> {
    const prefix = `${this.prefix}${dirKey}/`;
    const names: string[] = [];
    for await (const item of this.container.listBlobsByHierarchy('/', { prefix })) {
      const name = item.kind === 'prefix' ? item.name.slice(prefix.length, -1) : item.name.slice(prefix.length);
      if (name) names.push(name);
    }
    return names;
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse((await this.blob(key).downloadToBuffer()).toString('utf8')) as T;
    } catch (err) {
      if (statusOf(err) === 404 || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async createExclusive(key: string, data: Uint8Array | string): Promise<'created' | 'exists'> {
    const body = toBuffer(data);
    try {
      await this.blob(key).upload(body, body.byteLength, { conditions: { ifNoneMatch: '*' } });
      return 'created';
    } catch (err) {
      if (statusOf(err) === 409 || statusOf(err) === 412) return 'exists';
      throw err;
    }
  }

  async write(key: string, data: Uint8Array | string): Promise<void> {
    const body = toBuffer(data);
    await this.blob(key).upload(body, body.byteLength);
  }

  async remove(key: string): Promise<void> {
    await this.blob(key).deleteIfExists();
  }

  async removeTree(dirKey: string): Promise<void> {
    const names: string[] = [];
    for await (const item of this.container.listBlobsFlat({ prefix: `${this.prefix}${dirKey}/` })) names.push(item.name);
    for (const name of names) await this.container.getBlockBlobClient(name).deleteIfExists();
  }

  async readHead(key: string, byteCount: number): Promise<Uint8Array> {
    if (byteCount <= 0) return new Uint8Array(0);
    try {
      const res = await this.blob(key).download(0, byteCount);
      return await collect(res.readableStreamBody);
    } catch (err) {
      if (statusOf(err) === 416) return new Uint8Array(0); // empty blob
      throw err;
    }
  }

  async assemble(): Promise<never> {
    throw new Error('Azure control store does not assemble files; parts use Put Block / Put Block List.');
  }

  async promote(): Promise<never> {
    throw new Error('Azure control store does not move files.');
  }

  openRead(key: string): ReadableStream<Uint8Array> {
    const blob = this.blob(key);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!reader) {
          const res = await blob.download();
          const body = res.readableStreamBody;
          if (!body) return controller.close();
          reader = (Readable.toWeb(body as Readable) as ReadableStream<Uint8Array>).getReader();
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    });
  }
}

export async function createAzureBackend(config: AzureBackendConfig): Promise<CloudBackend> {
  const label = 'storage "azure_blob"';
  const sdk = await loadOptional<Sdk>('@azure/storage-blob', label);

  let service: AzureBlob.BlobServiceClient;
  let sharedKey: AzureBlob.StorageSharedKeyCredential | undefined;
  let accountName = '';
  if (config.connectionString) {
    service = sdk.BlobServiceClient.fromConnectionString(config.connectionString);
    accountName = connectionStringValue(config.connectionString, 'AccountName') ?? '';
    const key = connectionStringValue(config.connectionString, 'AccountKey');
    if (accountName && key) sharedKey = new sdk.StorageSharedKeyCredential(accountName, key);
  } else {
    const url = config.accountUrl as string;
    accountName = accountNameOf(config, url);
    if (config.accountKey) {
      sharedKey = new sdk.StorageSharedKeyCredential(accountName, config.accountKey);
      service = new sdk.BlobServiceClient(url, sharedKey);
    } else if (config.sasToken) {
      service = new sdk.BlobServiceClient(`${url}?${config.sasToken.replace(/^\?/, '')}`);
    } else {
      const identity = await loadOptional<typeof AzureIdentity>('@azure/identity', `${label} with Microsoft Entra ID`);
      service = new sdk.BlobServiceClient(url, new identity.DefaultAzureCredential());
    }
  }
  const container = service.getContainerClient(config.container);
  const control = new AzureControlStore(container, config.prefix);
  const blob = (key: string) => container.getBlockBlobClient(`${config.prefix}${key}`);
  const usesEntraId = !config.connectionString && !config.accountKey && !config.sasToken;
  const isHttp = (config.accountUrl ?? container.url).startsWith('http:');

  // Parts go to the staging blob when the session has one (direct transfer).
  const partsBlob = (session: CloudSessionRef) => blob(session.stagingKey ?? session.key);

  let delegation: { key: AzureBlob.UserDelegationKey; validUntil: number } | undefined;
  const KEY_MARGIN_MS = 5 * 60_000;
  // Azure's limit is 7 days; asked for a little less, so a local clock running
  // ahead of Azure's does not get the request refused.
  const KEY_MAX_MS = 7 * 24 * 3_600_000 - 2 * KEY_MARGIN_MS;
  /**
   * The key a SAS meant to last until `wantedExpiry` is signed with, and the
   * latest expiry it can carry. Azure refuses a user delegation SAS once its KEY
   * has expired, whatever the SAS says, so the SAS never outlives the key: the
   * key is fetched to cover the SAS (at least an hour, at most KEY_MAX_MS) and
   * reused while it still does. A shared key never expires.
   */
  async function signingKey(wantedExpiry: Date) {
    if (sharedKey) return { key: sharedKey, latestExpiry: wantedExpiry };
    const now = Date.now();
    const needed = Math.min(wantedExpiry.getTime() + KEY_MARGIN_MS, now + KEY_MAX_MS - KEY_MARGIN_MS);
    if (!delegation || delegation.validUntil < needed) {
      const validUntil = Math.min(now + KEY_MAX_MS, Math.max(now + 3_600_000, wantedExpiry.getTime() + 3 * KEY_MARGIN_MS));
      delegation = { key: await service.getUserDelegationKey(new Date(now - KEY_MARGIN_MS), new Date(validUntil)), validUntil };
    }
    return { key: delegation.key, latestExpiry: new Date(Math.min(wantedExpiry.getTime(), delegation.validUntil - KEY_MARGIN_MS)) };
  }

  /**
   * A SAS query string for one blob, signed by the account key or a user
   * delegation key, and the expiry it actually carries (never past its key's).
   */
  async function blobSas(blobName: string, permissions: string, wantedExpiry: Date): Promise<{ sas: string; expiresOn: Date }> {
    const { key, latestExpiry: expiresOn } = await signingKey(wantedExpiry);
    const values: AzureBlob.BlobSASSignatureValues = {
      containerName: config.container,
      blobName,
      permissions: sdk.BlobSASPermissions.parse(permissions),
      // Started 5 minutes back to tolerate clock skew.
      startsOn: new Date(Date.now() - 5 * 60_000),
      expiresOn,
      protocol: isHttp ? sdk.SASProtocol.HttpsAndHttp : sdk.SASProtocol.Https,
    };
    const sas = (
      key instanceof sdk.StorageSharedKeyCredential
        ? sdk.generateBlobSASQueryParameters(values, key) // service SAS (account key)
        : sdk.generateBlobSASQueryParameters(values, key, accountName) // user delegation SAS (Entra ID)
    ).toString();
    return { sas, expiresOn };
  }

  async function listParts(session: CloudSessionRef): Promise<CloudPart[]> {
    let list: AzureBlob.BlockBlobGetBlockListResponse;
    try {
      // A staging blob's COMMITTED blocks are this upload's parts too: a commit
      // that stopped before its copy to the final key leaves them there, and the
      // retry must find them to commit and copy again. On a final-key blob the
      // committed blocks are a stored file, and only uncommitted ones count.
      list = await partsBlob(session).getBlockList(session.stagingKey ? 'all' : 'uncommitted');
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
    // The same index staged twice (a retry with other bytes) leaves two blocks;
    // the later one listed wins. Uncommitted blocks are listed after committed.
    const byIndex = new Map<number, CloudPart>();
    for (const block of [...(list.committedBlocks ?? []), ...(list.uncommittedBlocks ?? [])]) {
      const parsed = parseAzureBlockId(block.name);
      if (parsed) byIndex.set(parsed.index, { index: parsed.index, size: block.size, sha256: parsed.sha256 });
    }
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
  }

  /**
   * Longest a `complete` waits for Azure's copy. Same-account copies normally
   * finish at once, but Azure does not promise it; this stays well under the
   * 15-minute complete lock, so the lock cannot go stale under a running copy.
   */
  const COPY_DEADLINE_MS = 10 * 60_000;

  /**
   * Direct transfer: copy the committed staging blob to the final key with the
   * server's own credentials. The final key never had a SAS, so what the content
   * check reads there afterwards is what stays stored.
   */
  async function copyToFinal(
    session: CloudSessionRef & { stagingKey: string },
    stagingEtag: string | undefined,
    contentType: string,
    checksum: CloudCommitResult['checksum'],
  ): Promise<CloudCommitResult> {
    const staging = blob(session.stagingKey);
    const final = blob(session.key);
    const { sas } = await blobSas(`${config.prefix}${session.stagingKey}`, 'r', new Date(Date.now() + COPY_DEADLINE_MS + 3_600_000));
    // Only the blob just committed: the browser's SAS is still valid, and if it
    // replaced the staging blob since, the copy fails (412) instead of storing
    // other bytes.
    const poller = await final.beginCopyFromURL(`${staging.url}?${sas}`, {
      intervalInMs: 1000,
      ...(stagingEtag ? { sourceConditions: { ifMatch: stagingEtag } } : {}),
    });
    let copied: AzureBlob.BlobBeginCopyFromURLResponse;
    // This SDK's poller takes no abort signal, so the deadline is a race with
    // the signal's abort event.
    const deadline = AbortSignal.timeout(COPY_DEADLINE_MS);
    const expired = new Promise<never>((_, reject) => {
      deadline.addEventListener('abort', () => reject(new Error('Azure copy to the final key did not finish in time')), { once: true });
    });
    expired.catch(() => undefined); // only ever observed through the race below
    try {
      copied = await Promise.race([poller.pollUntilDone(), expired]);
    } catch (err) {
      poller.stopPolling();
      // A copy still pending would make the retry's own copy fail (409).
      const copyId = poller.getOperationState().result?.copyId;
      if (copyId) await final.abortCopyFromURL(copyId).catch(() => undefined);
      throw err;
    }
    if (copied.copyStatus !== 'success') throw new Error(`Azure copy to the final key ended "${copied.copyStatus ?? 'unknown'}"`);
    // A copy carries the source's properties, and the browser's SAS can set the
    // staging blob's: the stored file's type is the server's again.
    await final.setHTTPHeaders({ blobContentType: contentType });
    // The size is the COPY's, not the parts' sum.
    const size = (await final.getProperties()).contentLength ?? 0;
    // The file is stored; a staging blob left behind lies inside the session
    // directory, which complete, discard and the sweep all remove.
    await staging.deleteIfExists().catch(() => undefined);
    return { key: session.key, size, checksum };
  }

  return {
    kind: 'azure_blob',
    control,
    directChecksums: ['sha256', 'md5'],
    supportsDirect: Boolean(sharedKey) || usesEntraId,

    async createSession(key, _contentType, stagingKey) {
      return { kind: 'azure_blob', key, ...(stagingKey ? { stagingKey } : {}) };
    },

    async abortSession(session) {
      // A staging blob is this session's alone, committed or not.
      if (session.stagingKey) {
        await blob(session.stagingKey).deleteIfExists();
        return;
      }
      const target = blob(session.key);
      // A COMMITTED blob at the final key is a stored file and must survive —
      // keys are unique per session, but a custom destination() may not be.
      // exists() is false while the blob holds only uncommitted blocks; Azure
      // drops those left on a committed blob at its next commit, or after 7 days.
      if (await target.exists()) return;
      // Deleting the blob discards its uncommitted blocks with it.
      await target.deleteIfExists();
    },

    async putPart(session, index, bytes, sha256) {
      const body = toBuffer(bytes);
      const md5 = createHash('md5').update(body).digest();
      await partsBlob(session).stageBlock(azureBlockId(index, sha256), body, body.byteLength, { transactionalContentMD5: md5 });
    },

    async presignPart(session, index, _length, sha256, md5Base64, ttlSeconds): Promise<DirectPartRequest> {
      if (!md5Base64) throw new Error('Azure direct parts need an MD5');
      // A write SAS can replace the WHOLE blob it names (Put Blob, not only Put
      // Block), so it must never name the final key — only the staging blob.
      if (!session.stagingKey) {
        throw new UploadError(
          'INVALID_REQUEST',
          'This upload was started before direct transfer applied to it and cannot continue that way. Discard it and upload the file again.',
        );
      }
      const target = blob(session.stagingKey);
      // Write only, one blob, short-lived — and never past its signing key.
      const { sas, expiresOn } = await blobSas(`${config.prefix}${session.stagingKey}`, 'w', new Date(Date.now() + ttlSeconds * 1000));
      const blockId = encodeURIComponent(azureBlockId(index, sha256));
      return {
        url: `${target.url}?comp=block&blockid=${blockId}&${sas}`,
        method: 'PUT',
        headers: { 'x-ms-version': AZURE_DIRECT_API_VERSION, 'Content-MD5': md5Base64 },
        expiresAt: expiresOn.toISOString(),
      };
    },

    listParts,

    async commit(session, parts, contentType): Promise<CloudCommitResult> {
      const ordered = [...parts].sort((a, b) => a.index - b.index);
      const committedBlocks = await partsBlob(session).commitBlockList(
        ordered.map((p) => azureBlockId(p.index, p.sha256 as string)),
        { blobHTTPHeaders: { blobContentType: contentType } },
      );
      const checksum = compositeSha256(ordered.map((p) => p.sha256));
      if (!session.stagingKey) return { key: session.key, size: ordered.reduce((sum, p) => sum + p.size, 0), checksum };
      return copyToFinal(session as CloudSessionRef & { stagingKey: string }, committedBlocks.etag, contentType, checksum);
    },

    readObjectHead: (key, byteCount) => control.readHead(key, byteCount),
    deleteObject: (key) => control.remove(key),
    openRead: (key) => control.openRead(key),
  };
}
