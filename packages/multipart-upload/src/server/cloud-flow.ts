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
import { UploadError, destinationExists } from '../core/errors.js';
import { SIGNATURE_BYTES } from '../core/file-signatures.js';
import { FILES_DIR, PARTS_DIR, directStagingKey, headKey, manifestKey, sessionKey } from '../core/layout.js';
import type { CloudSessionRef, CommittedFileRef, UploadManifest } from '../core/session.js';
import { ProviderSessionLostError, type CloudBackend, type CloudCommitResult, type CloudPart } from '../storage/cloud/types.js';
import { compositeSha256 } from '../storage/cloud/checksums.js';
import { backendOf, ownCommittedObject, touch, withoutMarker, writeControl, writeManifest } from './cloud-control.js';
import { DEFAULT_LOCK_STALE_MS, type CompleteResult, type CompletedFile, acquireLock, extensionOf, stillHeld } from './complete.js';
import type { HeldLock } from './lock.js';
import { assertContentAllowed, declaredTypeFor } from './file-types.js';
import { listCommittableCloudParts, readManifest, type StoreContext } from './store.js';
import type { UploaderOptions } from './uploader.js';

const DEFAULT_HEAD_BYTES = 64 * 1024;

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

/**
 * The provider dropped the session's multipart upload during the commit (see
 * ProviderSessionLostError). Its parts are gone and its id is dead, so a new
 * provider session is opened at the same key and recorded without a commit
 * marker; picking the file again resumes onto it and sends every part.
 */
async function restartSession(store: StoreContext, manifest: UploadManifest, lock: HeldLock, cause: Error): Promise<UploadError> {
  const old = sessionOf(manifest);
  if (await stillHeld(lock)) {
    const fresh = await backendOf(store).createSession(old.key, manifest.contentType ?? 'application/octet-stream', old.stagingKey);
    await writeManifest(store, { ...withoutMarker(manifest), cloud: fresh });
  }
  return new UploadError('INCOMPLETE', `${cause.message} Nothing was stored; send the file again.`, {
    missingParts: Array.from({ length: Math.min(manifest.partCount, 50) }, (_, i) => i + 1),
  });
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
    await writeControl(store.storage, headKey(store.namespaceKey, manifest.uploadId), record);
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
 * The file a previous `complete` committed but did not record — it stopped
 * (crash, deploy, timeout) between the provider's commit and the manifest
 * write. Without this, every retry would report INCOMPLETE for a file that is
 * stored. Any size: ownership is proved (holdsOwnCommit), and the caller's size
 * check refuses — and deletes — a wrong-sized one, e.g. a refused file whose
 * delete failed earlier. Its checksum is not recoverable.
 */
async function interruptedCommit(backend: CloudBackend, manifest: UploadManifest): Promise<CloudCommitResult | null> {
  const own = await ownCommittedObject(backend, manifest);
  return own ? { ...own, checksum: null } : null;
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
async function refused(store: StoreContext, uploadId: string, key: string, refusal: unknown, lock: HeldLock): Promise<unknown> {
  // A request that took the lock over (this one stalled in validateHead) owns
  // the file now and decides about it; deleting it here would pull it from
  // under that request.
  if (!(await stillHeld(lock))) return refusal;
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
  const lock = await acquireLock(store, uploadId, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);

  try {
    // Read again under the lock: a discard that held it may have removed it.
    let manifest = await readManifest(store, uploadId);
    if (!manifest) throw noSession();
    let committed = manifest.committed;
    // A recorded commit whose file is gone (a discard or the sweep deleted it
    // and stopped before removing the manifest) is not a success to report.
    if (committed && !(await backend.control.stat(committed.key))) {
      if (await stillHeld(lock)) await store.storage.remove(manifestKey(store.namespaceKey, uploadId)).catch(() => undefined);
      throw noSession();
    }

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
        // Every part gone after a commit started, and the object at the key is
        // not this upload's: another upload sharing the key committed there (on
        // Azure that discards this upload's uncommitted blocks). Say so — and
        // drop the marker — rather than report INCOMPLETE forever.
        if (parts.length === 0 && manifest.commitStartedAt && (await backend.control.stat(sessionOf(manifest).key))) {
          if (await stillHeld(lock)) await writeManifest(store, withoutMarker(manifest));
          throw destinationExists();
        }
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
        // not. This look gives the early, friendly refusal; the GUARANTEE is the
        // commit itself, which the storage refuses atomically when the key is
        // taken (If-None-Match) — two uploads that both pass this look cannot
        // both store. Skipped once the marker exists: an object then is a
        // previous attempt's own commit (Azure direct: copied, not yet recorded).
        const target = sessionOf(manifest).key;
        if (!manifest.commitStartedAt && (await backend.control.stat(target))) throw destinationExists();

        // Recorded before the commit so a crash after it is recognisable (see
        // interruptedCommit). A write failure stops here, before anything changes.
        await lock.confirm();
        manifest = { ...manifest, commitStartedAt: new Date().toISOString() };
        await writeManifest(store, manifest);
        let committedResult: CloudCommitResult;
        try {
          committedResult = await backend.commit(sessionOf(manifest), parts, declaredType, () => lock.refresh());
        } catch (err) {
          if (err instanceof ProviderSessionLostError) throw await restartSession(store, manifest, lock, err);
          if (!(err instanceof UploadError && err.code === 'DESTINATION_EXISTS')) throw err;
          const session = sessionOf(manifest);
          // A failure of the check itself is rethrown with the marker KEPT: clearing
          // it on a guess would orphan this upload's own commit, if that is what
          // the refusal met. Recovery still has to prove ownership to use it.
          if (await backend.holdsOwnCommit(session)) {
            // Refused by THIS upload's own object: the provider performed the
            // commit, its response was lost, and the SDK's automatic retry —
            // conditional on a free key — met the result. The commit is done.
            const stored = await backend.control.stat(session.key);
            committedResult = { key: session.key, size: stored?.size ?? 0, checksum: compositeSha256(parts.map((p) => p.sha256)) };
          } else {
            // Another upload's object. Nothing of this upload was stored, so no
            // commit marker may remain — not even one an earlier attempt left:
            // with it, recovery or a discard could take that object for this
            // upload's own.
            if (await stillHeld(lock)) await writeManifest(store, withoutMarker(manifest)).catch(() => undefined);
            throw err;
          }
        }
        await lock.refresh();
        // Azure verifies only MD5 per block, and when the browser wrote the
        // blocks their ids — which carry each part's SHA-256 — are its choice.
        // Such a composite would be the browser's claim, not a verified value.
        // (S3 verifies the SHA-256 signed into each part URL, so its stays.)
        result = backend.kind === 'azure_blob' && browserWrote(store, manifest) ? { ...committedResult, checksum: null } : committedResult;
      }
      // The provider consumed the parts, so a refused file cannot be kept for a
      // retry: it is deleted, with its session (see refused).
      if (result.size !== manifest.totalBytes) {
        throw await refused(
          store,
          uploadId,
          result.key,
          new UploadError('PART_LENGTH_MISMATCH', `Committed ${result.size} bytes but the upload declared ${manifest.totalBytes}.`),
          lock,
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
          throw await refused(store, uploadId, result.key, err, lock);
        }
      }

      committed = { key: result.key, size: result.size, contentType, checksum: result.checksum } satisfies CommittedFileRef;
      manifest = { ...manifest, committed };
      // A request that took the lock over (this one stalled past lockStaleMs)
      // finishes the file itself; recording it here as well would run
      // onComplete twice. The manifest must also still exist: a lock rewrite
      // that landed after a taker finished and removed the session would pass
      // confirm, and writing the manifest would revive that session.
      await lock.confirm();
      if (!(await readManifest(store, uploadId))) throw new UploadError('COMPLETE_IN_PROGRESS', 'Another request finished this upload.');
      await writeManifest(store, manifest);
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
      await lock.refresh();
      // On failure the committed file and the manifest stay: a retry re-runs
      // only onComplete. Discard or the sweep removes both if nobody retries.
      result = (await options.onComplete({ file, metadata: manifest.metadata, namespace, uploadId, deduplicated: false })) ?? null;
    }

    // The manifest goes FIRST, on its own. While it exists, a discard or the
    // sweep reads `committed` and deletes the file — right for an abandoned
    // upload, data loss for one the app has just recorded. The cloud stores
    // delete a tree key by key in name order (the lock before the manifest), so
    // removing the tree alone left that window open, and a partial failure most
    // often left exactly the manifest behind. Only while the lock is ours: a
    // request that took over during a long onComplete is finishing it itself.
    if (await stillHeld(lock)) {
      await store.storage.remove(manifestKey(store.namespaceKey, uploadId));
      // Leftover control files hold no record of the file; the sweep reclaims them.
      await store.storage.removeTree(sessionKey(store.namespaceKey, uploadId)).catch(() => undefined);
    }
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
    await lock.release().catch(() => undefined);
  }
}

