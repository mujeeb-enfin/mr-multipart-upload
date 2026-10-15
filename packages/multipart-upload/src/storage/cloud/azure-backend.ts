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

  let delegation: { key: AzureBlob.UserDelegationKey; validUntil: number } | undefined;
  async function signingKey(): Promise<AzureBlob.StorageSharedKeyCredential | AzureBlob.UserDelegationKey> {
    if (sharedKey) return sharedKey;
    // User delegation keys are valid for up to 7 days; one is fetched per hour.
    if (!delegation || delegation.validUntil < Date.now() + 10 * 60_000) {
      const startsOn = new Date(Date.now() - 5 * 60_000);
      const expiresOn = new Date(Date.now() + 60 * 60_000);
      delegation = { key: await service.getUserDelegationKey(startsOn, expiresOn), validUntil: expiresOn.getTime() };
    }
    return delegation.key;
  }

  async function listParts(session: CloudSessionRef): Promise<CloudPart[]> {
    let list: AzureBlob.BlockBlobGetBlockListResponse;
    try {
      list = await blob(session.key).getBlockList('uncommitted');
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
    // The same index staged twice (a retry with other bytes) leaves two blocks;
    // the most recently listed one wins, as a re-sent S3 part replaces the last.
    const byIndex = new Map<number, CloudPart>();
    for (const block of list.uncommittedBlocks ?? []) {
      const parsed = parseAzureBlockId(block.name);
      if (parsed) byIndex.set(parsed.index, { index: parsed.index, size: block.size, sha256: parsed.sha256 });
    }
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
  }

  return {
    kind: 'azure_blob',
    control,
    directChecksums: ['sha256', 'md5'],
    supportsDirect: Boolean(sharedKey) || usesEntraId,

    async createSession(key) {
      return { kind: 'azure_blob', key };
    },

    async abortSession(session) {
      const target = blob(session.key);
      // A COMMITTED blob at the key is a stored file — an earlier upload of the
      // same file shares the key — and must survive. exists() is false while the
      // blob holds only uncommitted blocks; Azure drops those left on a committed
      // blob at its next commit, or after 7 days.
      if (await target.exists()) return;
      // Deleting the blob discards its uncommitted blocks with it.
      await target.deleteIfExists();
    },

    async putPart(session, index, bytes, sha256) {
      const body = toBuffer(bytes);
      const md5 = createHash('md5').update(body).digest();
      await blob(session.key).stageBlock(azureBlockId(index, sha256), body, body.byteLength, { transactionalContentMD5: md5 });
    },

    async presignPart(session, index, _length, sha256, md5Base64, ttlSeconds): Promise<DirectPartRequest> {
      if (!md5Base64) throw new Error('Azure direct parts need an MD5');
      const target = blob(session.key);
      const expiresOn = new Date(Date.now() + ttlSeconds * 1000);
      const key = await signingKey();
      const values: AzureBlob.BlobSASSignatureValues = {
        containerName: config.container,
        blobName: `${config.prefix}${session.key}`,
        // Write only, one blob, short-lived. Started 5 minutes back to tolerate clock skew.
        permissions: sdk.BlobSASPermissions.parse('w'),
        startsOn: new Date(Date.now() - 5 * 60_000),
        expiresOn,
        protocol: isHttp ? sdk.SASProtocol.HttpsAndHttp : sdk.SASProtocol.Https,
      };
      const sas = (
        key instanceof sdk.StorageSharedKeyCredential
          ? sdk.generateBlobSASQueryParameters(values, key) // service SAS (account key)
          : sdk.generateBlobSASQueryParameters(values, key, accountName) // user delegation SAS (Entra ID)
      ).toString();
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
      await blob(session.key).commitBlockList(
        ordered.map((p) => azureBlockId(p.index, p.sha256 as string)),
        { blobHTTPHeaders: { blobContentType: contentType } },
      );
      return {
        key: session.key,
        size: ordered.reduce((sum, p) => sum + p.size, 0),
        checksum: compositeSha256(ordered.map((p) => p.sha256)),
      };
    },

    readObjectHead: (key, byteCount) => control.readHead(key, byteCount),
    deleteObject: (key) => control.remove(key),
    openRead: (key) => control.openRead(key),
  };
}
