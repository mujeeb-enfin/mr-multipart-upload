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

import { createHash, randomBytes } from 'node:crypto';

import type * as AzureBlob from '@azure/storage-blob';
import type * as AzureIdentity from '@azure/identity';

import { UploadError, destinationExists } from '../../core/errors.js';
import type { CloudSessionRef } from '../../core/session.js';
import { AzureControlStore, statusOf, toBuffer } from './azure-control-store.js';
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

/**
 * Azure refusing a write because the blob is already there: 409
 * BlobAlreadyExists, 412 ConditionNotMet / TargetConditionNotMet (Azure and
 * Azurite word an unmet `If-None-Match` differently), or 409
 * PendingCopyOperation (a copy onto it is still running). A 409 alone is not
 * enough — it also means a lease. The caller then looks at who holds the blob.
 */
function isTaken(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'SourceConditionNotMet') return false;
  return (
    code === 'BlobAlreadyExists' ||
    code === 'ConditionNotMet' ||
    code === 'TargetConditionNotMet' ||
    code === 'PendingCopyOperation' ||
    (statusOf(err) === 412 && code === undefined)
  );
}

/** Metadata stamped on the final blob BY the copy, naming the session that made it. */
const SESSION_METADATA = 'mpusession';

/** Azure refusing a copy because its SOURCE no longer matches (`sourceConditions.ifMatch`). */
function isSourceChanged(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'SourceConditionNotMet';
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
      // Only THIS session's blocks: another session sharing the blob (a
      // non-unique destination()) carries a different tag.
      if (parsed && parsed.sessionTag === session.blockTag) {
        byIndex.set(parsed.index, { index: parsed.index, size: block.size, sha256: parsed.sha256 });
      }
    }
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
  }

  /**
   * Longest a `complete` waits for Azure's copy. Same-account copies normally
   * finish at once, but Azure does not promise it. The complete lock is kept
   * fresh meanwhile by the heartbeat.
   */
  const COPY_DEADLINE_MS = 10 * 60_000;
  /** How often, at most, the heartbeat refreshes the complete lock during a copy. */
  const HEARTBEAT_EVERY_MS = 30_000;

  /**
   * Whether the blob at the final key is a copy THIS session made, and its copy
   * state. Two proofs, either enough: the metadata the copy itself stamped
   * (SESSION_METADATA = the session's block tag), and the recorded copy source
   * (this session's staging blob). Azure drops the copy properties once a blob
   * is modified after its copy — nothing here modifies the final blob, but the
   * metadata does not depend on that. A missing blob is nobody's copy.
   */
  async function holdsOwnCopy(session: CloudSessionRef & { stagingKey: string }) {
    const final = blob(session.key);
    const props = await final.getProperties().catch((err: unknown) => {
      if (statusOf(err) === 404) return null;
      throw err;
    });
    if (!props) return { own: false, status: undefined, copyId: undefined };
    const source = props.copySource ? new URL(props.copySource).pathname : '';
    const bySource = source !== '' && source === new URL(blob(session.stagingKey).url).pathname;
    const byStamp = session.blockTag !== undefined && props.metadata?.[SESSION_METADATA] === session.blockTag;
    // Without copy properties a concluded copy reads as no status; it concluded.
    return { own: bySource || byStamp, status: props.copyStatus ?? 'success', copyId: props.copyId };
  }

  /** Resolves after `ms`, event-driven (no timers). */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => AbortSignal.timeout(ms).addEventListener('abort', () => resolve(), { once: true }));

  /** Wait for a copy already running onto `final` (a stopped attempt's own), at most COPY_DEADLINE_MS. */
  async function awaitRunningCopy(final: AzureBlob.BlockBlobClient, beat: () => void): Promise<void> {
    const until = Date.now() + COPY_DEADLINE_MS;
    for (;;) {
      const status = (await final.getProperties()).copyStatus;
      if (status === 'success') return;
      if (status !== 'pending') throw new Error(`Azure copy to the final key ended "${status ?? 'unknown'}"`);
      if (Date.now() > until) throw new Error('Azure copy to the final key did not finish in time');
      beat();
      await pause(1000);
    }
  }

  /**
   * Direct transfer: copy the committed staging blob to the final key with the
   * server's own credentials. The final key never had a SAS, so what the content
   * check reads there afterwards is what stays stored.
   */
  async function copyToFinal(
    session: CloudSessionRef & { stagingKey: string },
    stagingEtag: string | undefined,
    checksum: CloudCommitResult['checksum'],
    heartbeat: (() => Promise<void>) | undefined,
  ): Promise<CloudCommitResult> {
    const staging = blob(session.stagingKey);
    const final = blob(session.key);
    const { sas } = await blobSas(`${config.prefix}${session.stagingKey}`, 'r', new Date(Date.now() + COPY_DEADLINE_MS + 3_600_000));
    // Keeps the complete lock fresh while Azure copies: one refresh at a time,
    // at most every HEARTBEAT_EVERY_MS, and awaited before returning — a refresh
    // still running after the commit could otherwise rewrite a lock that the
    // complete has since released.
    let beating: Promise<void> | null = null;
    let lastBeat = Date.now();
    const beat = () => {
      if (!heartbeat || beating || Date.now() - lastBeat < HEARTBEAT_EVERY_MS) return;
      lastBeat = Date.now();
      beating = heartbeat()
        .catch(() => undefined) // a takeover is caught by the caller's own refresh after the commit
        .finally(() => {
          beating = null;
        });
    };
    const startCopy = (onlyIfFree: boolean) =>
      final.beginCopyFromURL(`${staging.url}?${sas}`, {
        intervalInMs: 1000,
        onProgress: beat,
        // Set BY the copy: proof the result is this session's (holdsOwnCopy).
        ...(session.blockTag ? { metadata: { [SESSION_METADATA]: session.blockTag } } : {}),
        // Only the blob just committed: the browser's SAS is still valid, and if
        // it replaced the staging blob since, the copy fails instead of storing
        // other bytes.
        ...(stagingEtag ? { sourceConditions: { ifMatch: stagingEtag } } : {}),
        // Only onto a free key — atomically, whatever destination() returned.
        ...(onlyIfFree ? { conditions: { ifNoneMatch: '*' } } : {}),
      });

    try {
      let poller: Awaited<ReturnType<typeof startCopy>> | null = null;
      try {
        poller = await startCopy(true);
      } catch (err) {
        if (isSourceChanged(err)) {
          throw new Error('The staged parts changed during the commit (the staging blob was rewritten); send the file again.');
        }
        if (!isTaken(err)) throw err;
        // Taken. By this session's own earlier copy — a retry after a complete
        // that stopped after copying, or the SDK retrying a start whose response
        // was lost — it is reused, awaited while still running, or copied again
        // if it failed; by anything else it is refused, untouched.
        const existing = await holdsOwnCopy(session);
        if (!existing.own) throw destinationExists();
        if (existing.status === 'pending') await awaitRunningCopy(final, beat);
        else if (existing.status !== 'success') poller = await startCopy(false);
      }
      if (poller) await waitForCopy(poller, final);
    } finally {
      await beating;
    }
    // The content type is the server's: commitBlockList set it on the staging
    // blob, and the copy is conditional on that blob's ETag — which changes if
    // the browser alters its properties too. The final blob is NOT modified
    // after the copy (Azure would drop its copy properties, an ownership proof).
    // The size is the COPY's, not the parts' sum.
    const size = (await final.getProperties()).contentLength ?? 0;
    // The file is stored; a staging blob left behind lies inside the session
    // directory, which complete, discard and the sweep all remove.
    await staging.deleteIfExists().catch(() => undefined);
    return { key: session.key, size, checksum };
  }

  /** Wait for a server-side copy, at most COPY_DEADLINE_MS; a copy still pending then is aborted. */
  async function waitForCopy(
    poller: Awaited<ReturnType<AzureBlob.BlockBlobClient['beginCopyFromURL']>>,
    final: AzureBlob.BlockBlobClient,
  ): Promise<void> {
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
  }

  return {
    kind: 'azure_blob',
    control,
    directChecksums: ['sha256', 'md5'],
    supportsDirect: Boolean(sharedKey) || usesEntraId,

    async createSession(key, _contentType, stagingKey) {
      return { kind: 'azure_blob', key, blockTag: randomBytes(8).toString('hex'), ...(stagingKey ? { stagingKey } : {}) };
    },

    async abortSession(session) {
      if (session.stagingKey) {
        // A copy this session started at the final key — still running, failed
        // or aborted — goes with it (a running one is stopped first); a finished
        // one is the caller's to judge (releaseCloudSession). The staging blob is
        // this session's alone, committed or not.
        const staged = session as CloudSessionRef & { stagingKey: string };
        const copy = await holdsOwnCopy(staged).catch(() => ({ own: false, status: undefined, copyId: undefined }));
        if (copy.own && copy.status !== 'success') {
          if (copy.status === 'pending' && copy.copyId) await blob(session.key).abortCopyFromURL(copy.copyId).catch(() => undefined);
          await blob(session.key).deleteIfExists();
        }
        await blob(session.stagingKey).deleteIfExists();
        return;
      }
      // Proxy: the uncommitted blocks sit on the final blob, and deleting it is
      // not safe — between a look ("no stored file there yet") and the delete,
      // another upload given the same key by a custom destination() may commit
      // its file there. Azure discards uncommitted blocks itself after 7 days.
    },

    async putPart(session, index, bytes, sha256) {
      const body = toBuffer(bytes);
      const md5 = createHash('md5').update(body).digest();
      await partsBlob(session).stageBlock(azureBlockId(index, sha256, session.blockTag), body, body.byteLength, { transactionalContentMD5: md5 });
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
      const blockId = encodeURIComponent(azureBlockId(index, sha256, session.blockTag));
      return {
        url: `${target.url}?comp=block&blockid=${blockId}&${sas}`,
        method: 'PUT',
        headers: { 'x-ms-version': AZURE_DIRECT_API_VERSION, 'Content-MD5': md5Base64 },
        expiresAt: expiresOn.toISOString(),
      };
    },

    listParts,

    async commit(session, parts, contentType, heartbeat): Promise<CloudCommitResult> {
      const ordered = [...parts].sort((a, b) => a.index - b.index);
      let committedBlocks: AzureBlob.BlockBlobCommitBlockListResponse;
      try {
        committedBlocks = await partsBlob(session).commitBlockList(
          ordered.map((p) => azureBlockId(p.index, p.sha256 as string, session.blockTag)),
          {
            blobHTTPHeaders: { blobContentType: contentType },
            // Proxy: the blocks sit on the final blob itself, so the commit is
            // made only if it holds no stored file yet — atomically, whatever
            // destination() returned. (A blob with only uncommitted blocks does
            // not exist yet.) A staging blob is this session's own.
            ...(session.stagingKey ? {} : { conditions: { ifNoneMatch: '*' } }),
          },
        );
      } catch (err) {
        if (isTaken(err)) throw destinationExists();
        throw err;
      }
      const checksum = compositeSha256(ordered.map((p) => p.sha256));
      if (!session.stagingKey) return { key: session.key, size: ordered.reduce((sum, p) => sum + p.size, 0), checksum };
      return copyToFinal(session as CloudSessionRef & { stagingKey: string }, committedBlocks.etag, checksum, heartbeat);
    },

    async holdsOwnCommit(session) {
      const final = blob(session.key);
      // Direct: the final blob is a finished copy this session made.
      if (session.stagingKey) {
        const copy = await holdsOwnCopy(session as CloudSessionRef & { stagingKey: string });
        return copy.own && copy.status === 'success';
      }
      // Proxy: every committed block carries this session's tag. A session
      // started before tags existed cannot prove anything — another such
      // session's file would look the same — so it never claims ownership.
      if (!session.blockTag) return false;
      let list: AzureBlob.BlockBlobGetBlockListResponse;
      try {
        list = await final.getBlockList('committed');
      } catch (err) {
        if (statusOf(err) === 404) return false;
        throw err;
      }
      const blocks = list.committedBlocks ?? [];
      return (
        blocks.length > 0 &&
        blocks.every((block) => {
          const parsed = parseAzureBlockId(block.name);
          return parsed !== null && parsed.sessionTag === session.blockTag;
        })
      );
    },

    readObjectHead: (key, byteCount) => control.readHead(key, byteCount),
    deleteObject: (key) => control.remove(key),
    openRead: (key) => control.openRead(key),
  };
}
