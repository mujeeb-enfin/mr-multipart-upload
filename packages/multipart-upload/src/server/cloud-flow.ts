// ---------------------------------------------------------------------------
// cloud-flow.ts — the upload operations on aws_s3 / minio / azure_blob
// ---------------------------------------------------------------------------
//
// Everything that is the same for every backend stays in uploader.ts: auth,
// namespaces, the SHA-256 upload id, size limits, allowedTypes check 1, error
// codes. This file is what differs once bytes live in the provider's multipart
// session instead of in part files.
//
// THE CONTENT CHECK (allowedTypes check 2, validateHead) must see the file's
// first bytes, and neither S3 nor Azure can read parts before they are
// committed. So:
//   proxy   the first bytes are kept when part 1 passes through the server,
//           and the check runs BEFORE commit — a refused file never exists,
//           and its parts are kept, as with local storage.
//   direct  the server never sees the bytes; the check runs right AFTER
//           commit on a ranged read, and a refused file is deleted.
//
// A COMMITTED FILE IS RECORDED in the manifest before onComplete runs. If
// onComplete throws, the provider has already consumed the parts, so a retry
// must not commit again: it finds `committed` and only re-runs onComplete.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';

import { expectedPartBytes } from '../core/arithmetic.js';
import { UploadError } from '../core/errors.js';
import { SIGNATURE_BYTES } from '../core/file-signatures.js';
import { FILES_DIR, PARTS_DIR, activityKey, directStagingKey, headKey, lockKey, manifestKey, sessionKey } from '../core/layout.js';
import type { CloudSessionRef, CommittedFileRef, UploadManifest } from '../core/session.js';
import type { CloudBackend, CloudCommitResult, CloudPart } from '../storage/cloud/types.js';
import { DEFAULT_LOCK_STALE_MS, type CompleteResult, type CompletedFile, acquireLock, extensionOf } from './complete.js';
import { assertContentAllowed, declaredTypeFor } from './file-types.js';
import { listCommittableCloudParts, readManifest, type StoreContext } from './store.js';
import type { UploaderOptions } from './uploader.js';

const DEFAULT_HEAD_BYTES = 64 * 1024;

export function backendOf(store: StoreContext): CloudBackend {
  if (!store.backend) throw new Error('cloud operation on a store without a cloud backend');
  return store.backend;
}

function sessionOf(manifest: UploadManifest) {
  if (!manifest.cloud) throw new UploadError('NO_SESSION', 'This upload was started on another storage backend.');
  return manifest.cloud;
}

/**
 * Storage key of the final object, fixed when the session begins. Unique to the
 * session: the upload id is the same for every upload of the same file, so a
 * key built from it alone would let a re-upload overwrite — and, if refused or
 * discarded, delete — the earlier stored copy. Resuming keeps the key, because
 * it is read back from the manifest; only a NEW session mints one.
 */
export function cloudDestinationFor(
  store: StoreContext,
  options: UploaderOptions,
  uploadId: string,
  fileName: string,
  sessionId: string,
): string {
  const extension = extensionOf(fileName);
  // Content-addressing is impossible here: the provider needs the key before
  // any byte arrives.
  const key = options.destination
    ? options.destination({ sha256: '', extension, namespaceKey: store.namespaceKey, fileName, uploadId, sessionId })
    : `${FILES_DIR}/${store.namespaceKey}/${uploadId}-${sessionId}${extension ? `.${extension}` : ''}`;
  if (typeof key !== 'string' || key.length === 0 || key.includes('..') || key.startsWith('/')) {
    throw new UploadError('CONFIG_INVALID', 'destination() must return a non-empty relative storage key without ".."');
  }
  if (key === PARTS_DIR || key.startsWith(`${PARTS_DIR}/`)) {
    throw new UploadError('CONFIG_INVALID', `destination() must not point inside ${PARTS_DIR}/`);
  }
  return key;
}

/** Open the provider session for a NEW upload: a fresh final key, and the Azure direct staging blob. */
export async function openCloudSession(
  store: StoreContext,
  options: UploaderOptions,
  uploadId: string,
  fileName: string,
  contentType: string,
): Promise<CloudSessionRef> {
  const backend = backendOf(store);
  const sessionId = randomBytes(8).toString('hex');
  const key = cloudDestinationFor(store, options, uploadId, fileName, sessionId);
  // An Azure write SAS can replace the WHOLE blob it names (Put Blob, not only
  // Put Block). Naming the final key would let a browser overwrite the file
  // after it passed the content check, so the browser writes a staging blob.
  const staged = backend.kind === 'azure_blob' && store.storageConfig.transfer === 'direct';
  return backend.createSession(key, contentType, staged ? directStagingKey(store.namespaceKey, uploadId, sessionId) : undefined);
}

async function touch(store: StoreContext, uploadId: string): Promise<void> {
  await store.storage.write?.(activityKey(store.namespaceKey, uploadId), new Date().toISOString());
}

/** Store one part that passed through the server (proxy transfer). */
export async function storeCloudPart(
  store: StoreContext,
  manifest: UploadManifest,
  index: number,
  bytes: Uint8Array,
  sha256: string,
  headBytes: number | undefined,
): Promise<void> {
  const backend = backendOf(store);
  await backend.putPart(sessionOf(manifest), index, bytes, sha256);
  if (index === 1) {
    // The head is stored WITH the SHA-256 of the part it came from. Two
    // concurrent sends of part 1 with different bytes could otherwise leave the
    // provider holding one version and the head the other — and the check would
    // approve bytes that are not the ones committed. At complete the head is
    // trusted only if this hash equals the provider's record of part 1.
    const keep = Math.max(headBytes ?? DEFAULT_HEAD_BYTES, SIGNATURE_BYTES);
    const record = new Uint8Array(32 + Math.min(keep, bytes.byteLength));
    record.set(Buffer.from(sha256, 'hex'), 0);
    record.set(bytes.subarray(0, keep), 32);
    await store.storage.write?.(headKey(store.namespaceKey, manifest.uploadId), record);
  }
  await touch(store, manifest.uploadId);
}

/** The kept head of part 1, only if it provably belongs to the part the provider holds. */
async function trustedHead(store: StoreContext, uploadId: string, part1: CloudPart | undefined, bytes: number): Promise<Uint8Array | null> {
  // With direct transfer the browser may send part 1 straight to the provider
  // after a head was kept; only the committed bytes are evidence.
  if (store.storageConfig.transfer === 'direct' || !part1?.sha256) return null;
  const record = await store.storage.readHead(headKey(store.namespaceKey, uploadId), 32 + bytes);
  if (record.byteLength <= 32) return null;
  return Buffer.from(record.subarray(0, 32)).toString('hex') === part1.sha256 ? record.subarray(32) : null;
}

/** A signed request the browser sends part `index` with (direct transfer). */
export async function presignCloudPart(
  store: StoreContext,
  manifest: UploadManifest,
  index: number,
  sha256: string,
  md5Base64: string | undefined,
) {
  const backend = backendOf(store);
  const length = expectedPartBytes(index, manifest.partBytes, manifest.totalBytes);
  const request = await backend.presignPart(sessionOf(manifest), index, length, sha256, md5Base64, store.storageConfig.directUrlTtlSeconds);
  await touch(store, manifest.uploadId);
  return { ...request, index, length };
}

/**
 * The object THIS upload's commit left at its key, when the commit's outcome
 * was never recorded: a commit was started (`commitStartedAt`), the provider
 * holds no parts any more, and an object exists. Without the marker an object
 * there is not this upload's — a custom `destination()` gave another upload
 * the same key — and must be neither claimed nor deleted.
 */
async function ownCommittedObject(backend: CloudBackend, manifest: UploadManifest): Promise<{ key: string; size: number } | null> {
  if (!manifest.commitStartedAt || !manifest.cloud) return null;
  if ((await backend.listParts(manifest.cloud)).length > 0) return null;
  const info = await backend.control.stat(manifest.cloud.key).catch(() => null);
  return info && !info.isDirectory ? { key: manifest.cloud.key, size: info.size } : null;
}

/**
 * The file a previous `complete` committed but did not record — it stopped
 * (crash, deploy, timeout) between the provider's commit and the manifest
 * write. Without this, every retry would report INCOMPLETE for a file that is
 * stored. Only at exactly the declared size; its checksum is not recoverable.
 */
async function interruptedCommit(backend: CloudBackend, manifest: UploadManifest): Promise<CloudCommitResult | null> {
  const own = await ownCommittedObject(backend, manifest);
  return own && own.size === manifest.totalBytes ? { ...own, checksum: null } : null;
}

/**
 * True when the browser could write the bytes being committed without the
 * server seeing them: direct transfer, or a session with an Azure staging blob
 * (its SAS may still be valid even after the operator switched to proxy). Then
 * no kept head is trusted and the stored file is checked after the commit; on
 * Azure no composite checksum is claimed either.
 */
function browserWrote(store: StoreContext, manifest: UploadManifest): boolean {
  return store.storageConfig.transfer === 'direct' || Boolean(manifest.cloud?.stagingKey);
}

/**
 * Delete a committed file this upload must not keep, then its session, and
 * return the refusal to throw. If the delete fails the session STAYS — its
 * manifest (with the commit marker) is the only record of the file, and a
 * retry, discard or the sweep deletes it later — and the refusal says so, so
 * the failure is not hidden behind a 4xx nobody reports.
 */
async function refused(store: StoreContext, uploadId: string, key: string, refusal: unknown): Promise<unknown> {
  const deleted = await backendOf(store)
    .deleteObject(key)
    .then(() => true)
    .catch(() => false);
  if (deleted) {
    await store.storage.remove(manifestKey(store.namespaceKey, uploadId)).catch(() => undefined);
    await store.storage.removeTree(sessionKey(store.namespaceKey, uploadId)).catch(() => undefined);
    return refusal;
  }
  if (!(refusal instanceof UploadError)) return refusal;
  return new UploadError(
    refusal.code,
    `${refusal.message} The refused file could not be deleted yet; discarding this upload removes it.`,
    { ...refusal.details, refusedFileKept: true },
  );
}

/** Run allowedTypes check 2 and validateHead on the file's first bytes. */
async function checkHead(head: Uint8Array, manifest: UploadManifest, namespace: string, store: StoreContext, options: UploaderOptions) {
  const declaredType = manifest.contentType ?? declaredTypeFor(manifest.fileName, undefined);
  const contentType = assertContentAllowed(store.config.allowedTypes, head, manifest.fileName, declaredType);
  if (options.validateHead) {
    try {
      await options.validateHead(head.subarray(0, options.headBytes ?? DEFAULT_HEAD_BYTES), {
        fileName: manifest.fileName,
        totalBytes: manifest.totalBytes,
        metadata: manifest.metadata,
        namespace,
      });
    } catch (err) {
      if (err instanceof UploadError) throw err;
      throw new UploadError('REJECTED', err instanceof Error ? err.message : 'The file was rejected.');
    }
  }
  return contentType;
}

export async function completeCloudUpload(
  store: StoreContext,
  uploadId: string,
  namespace: string,
  options: UploaderOptions,
): Promise<CompleteResult> {
  const backend = backendOf(store);
  const noSession = () => new UploadError('NO_SESSION', `No upload in progress for "${uploadId}"`);
  if (!(await readManifest(store, uploadId))) throw noSession();
  await acquireLock(store, uploadId, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);

  try {
    // Read again under the lock: a discard that held it may have removed it.
    let manifest = await readManifest(store, uploadId);
    if (!manifest) throw noSession();
    let committed = manifest.committed;

    if (!committed) {
      const parts = await listCommittableCloudParts(store, manifest);
      const headSize = Math.max(options.headBytes ?? DEFAULT_HEAD_BYTES, SIGNATURE_BYTES);
      const declaredType = manifest.contentType ?? declaredTypeFor(manifest.fileName, undefined);
      let contentTypeBefore: string | undefined;
      let result: CloudCommitResult;

      const recovered = parts.length === 0 ? await interruptedCommit(backend, manifest) : null;
      if (recovered) {
        // A previous complete committed the file and stopped before recording
        // it: the provider has consumed the parts, so there is nothing to
        // commit again. The stored bytes are checked below like a direct upload.
        result = recovered;
      } else {
        const present = new Set(parts.map((p) => p.index));
        const missing: number[] = [];
        for (let i = 1; i <= manifest.partCount; i += 1) if (!present.has(i)) missing.push(i);
        if (missing.length > 0) {
          throw new UploadError('INCOMPLETE', `${missing.length} part(s) have not been uploaded yet.`, { missingParts: missing.slice(0, 50) });
        }

        const keptHead = browserWrote(store, manifest)
          ? null
          : await trustedHead(store, uploadId, parts.find((p) => p.index === 1), headSize);
        // Proxy transfer kept a verified head: check BEFORE the file exists. The
        // parts stay if it is refused, exactly as with local storage.
        contentTypeBefore = keptHead ? await checkHead(keptHead, manifest, namespace, store, options) : undefined;

        // Never commit over an object this upload did not create. Default keys
        // are unique per session, so this guards a custom destination() that is
        // not. Skipped once the marker exists: an object then is a previous
        // attempt's own commit (Azure direct: copied but not yet recorded).
        const target = sessionOf(manifest).key;
        if (!manifest.commitStartedAt && (await backend.control.stat(target))) {
          // No key in the details: it can name another user's file, and it shows
          // the storage layout. The operator finds it from the upload id.
          throw new UploadError('DESTINATION_EXISTS', 'A file already exists at this upload\'s storage key; it was not overwritten.');
        }

        // Recorded before the commit so a crash after it is recognisable (see
        // interruptedCommit). A write failure stops here, before anything changes.
        manifest = { ...manifest, commitStartedAt: new Date().toISOString() };
        await store.storage.write?.(manifestKey(store.namespaceKey, uploadId), JSON.stringify(manifest, null, 2));
        const committedResult = await backend.commit(sessionOf(manifest), parts, declaredType);
        // Azure verifies only MD5 per block, and when the browser wrote the
        // blocks their ids — which carry each part's SHA-256 — are its choice.
        // Such a composite would be the browser's claim, not a verified value.
        // (S3 verifies the SHA-256 signed into each part URL, so its stays.)
        result = backend.kind === 'azure_blob' && browserWrote(store, manifest) ? { ...committedResult, checksum: null } : committedResult;
      }
      // The provider consumed the parts, so a refused file cannot be kept for a
      // retry: it is deleted, with its session (see deleteRefusedFile).
      if (result.size !== manifest.totalBytes) {
        throw await refused(
          store,
          uploadId,
          result.key,
          new UploadError('PART_LENGTH_MISMATCH', `Committed ${result.size} bytes but the upload declared ${manifest.totalBytes}.`),
        );
      }

      let contentType = contentTypeBefore;
      if (contentType === undefined) {
        // The server never saw these bytes (direct transfer, or a staging blob
        // the browser could write): check what is stored now.
        const head = await backend.readObjectHead(result.key, headSize);
        try {
          contentType = await checkHead(head, manifest, namespace, store, options);
        } catch (err) {
          throw await refused(store, uploadId, result.key, err);
        }
      }

      committed = { key: result.key, size: result.size, contentType, checksum: result.checksum } satisfies CommittedFileRef;
      manifest = { ...manifest, committed };
      await store.storage.write?.(manifestKey(store.namespaceKey, uploadId), JSON.stringify(manifest, null, 2));
    }

    const file: CompletedFile = {
      key: committed.key,
      localPath: undefined,
      size: committed.size,
      sha256: '',
      checksum: committed.checksum,
      fileName: manifest.fileName,
      contentType: committed.contentType,
      read: () => backend.openRead(committed.key),
    };

    let result: unknown = null;
    if (options.onComplete) {
      // On failure the committed file and the manifest stay: a retry re-runs
      // only onComplete. Discard or the sweep removes both if nobody retries.
      result = (await options.onComplete({ file, metadata: manifest.metadata, namespace, uploadId, deduplicated: false })) ?? null;
    }

    // The manifest goes FIRST, on its own. While it exists, a discard or the
    // sweep reads `committed` and deletes the file — right for an abandoned
    // upload, data loss for one the app has just recorded. The cloud stores
    // delete a tree key by key in name order (the lock before the manifest), so
    // removing the tree alone left that window open, and a partial failure most
    // often left exactly the manifest behind.
    await store.storage.remove(manifestKey(store.namespaceKey, uploadId));
    // Leftover control files hold no record of the file; the sweep reclaims them.
    await store.storage.removeTree(sessionKey(store.namespaceKey, uploadId)).catch(() => undefined);
    return {
      uploadId,
      fileName: manifest.fileName,
      key: committed.key,
      size: committed.size,
      sha256: '',
      checksum: committed.checksum,
      contentType: committed.contentType,
      deduplicated: false,
      result,
    };
  } finally {
    await store.storage.remove(lockKey(store.namespaceKey, uploadId)).catch(() => undefined);
  }
}

/**
 * Release everything an abandoned session holds at the provider: the committed
 * file, a file whose commit was never recorded (any size — the marker proves it
 * is this upload's), or the open multipart session.
 */
async function releaseCloudSession(backend: CloudBackend, manifest: UploadManifest | null): Promise<void> {
  if (manifest?.committed) return backend.deleteObject(manifest.committed.key);
  if (!manifest?.cloud) return;
  // A staged session (Azure direct) keeps its committed blocks in the staging
  // blob until the copy is done and the staging blob deleted, so "no parts left"
  // cannot tell there whether the final key holds a copy. Once a commit started,
  // anything at the final key is that copy: the browser never had a URL for it,
  // and DESTINATION_EXISTS refused an occupied key before the marker was written.
  const orphan =
    manifest.cloud.stagingKey && manifest.commitStartedAt
      ? await backend.control.stat(manifest.cloud.key).catch(() => null)
      : await ownCommittedObject(backend, manifest);
  if (orphan) await backend.deleteObject(manifest.cloud.key);
  await backend.abortSession(manifest.cloud);
}

export async function discardCloudUpload(store: StoreContext, uploadId: string): Promise<void> {
  await releaseCloudSession(backendOf(store), await readManifest(store, uploadId));
  // Manifest first, as in complete: once it is gone a retried complete finds
  // NO_SESSION instead of reporting success for a file just deleted.
  await store.storage.remove(manifestKey(store.namespaceKey, uploadId));
  await store.storage.removeTree(sessionKey(store.namespaceKey, uploadId));
}

/** For the sweep: release the provider side of a stale session before its files go. */
export function cloudSweepRelease(backend: CloudBackend) {
  return async (dirKey: string) => releaseCloudSession(backend, await backend.control.readJson<UploadManifest>(`${dirKey}/manifest.json`));
}
