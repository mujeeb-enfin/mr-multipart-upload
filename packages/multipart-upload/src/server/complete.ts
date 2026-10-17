// ---------------------------------------------------------------------------
// complete.ts — assemble the parts into one stored file
// ---------------------------------------------------------------------------
//
// The ORDER of these steps is the safety argument:
//
//   lock        two concurrent completes cannot both assemble
//   prune       remove wrong-size parts — safe only now, under the lock
//   verify      refuse while any part is missing, naming which
//   head        check the content against allowedTypes, then let the
//               application reject the file — BEFORE assembling 400 MB
//   assemble    stream + hash in one pass; byte count must equal the manifest
//   dedupe      identical bytes already stored -> reuse, do not duplicate
//   promote     publish at the content-addressed key
//   onComplete  the application records it; only then are the parts deleted
//
// ON FAILURE AFTER ASSEMBLY THE PARTS ARE KEPT, so a retry costs one assembly,
// not a re-upload. The sweep reclaims them if the user gives up.
//
// DEDUPE IS PER NAMESPACE. The default destination includes the namespace hash.
// A store shared across users would tell user A, through `deduplicated: true`,
// that user B had already uploaded the identical file — a known side channel of
// cross-user dedupe. Applications that want global dedupe can opt in through
// `destination`, knowingly.
// ---------------------------------------------------------------------------

import { UploadError, destinationExists } from '../core/errors.js';
import { FILES_DIR, PARTS_DIR, parsePartFileName, partKey, sessionKey, stagingKeyForGeneration } from '../core/layout.js';
import { expectedPartBytes } from '../core/arithmetic.js';
import { SIGNATURE_BYTES } from '../core/file-signatures.js';
import type { FileChecksum, UploadMetadata } from '../core/session.js';
import { assertContentAllowed, declaredTypeFor } from './file-types.js';
import { acquireLock, DEFAULT_LOCK_STALE_MS, type HeldLock } from './lock.js';
import { partTagFor } from './namespace.js';
import { readManifest, readSession, type StoreContext } from './store.js';
import type { UploaderOptions } from './uploader.js';

// Defined in lock.ts; re-exported so existing imports keep working.
export { acquireLock, DEFAULT_LOCK_STALE_MS, discardUnderLock } from './lock.js';
const DEFAULT_HEAD_BYTES = 64 * 1024;

export interface CompletedFile {
  /** Storage key, relative to the storage root. */
  readonly key: string;
  /** Absolute path on disk, when the backend has one (the filesystem does). */
  readonly localPath: string | undefined;
  readonly size: number;
  /**
   * Lowercase hex SHA-256 of the stored bytes — local storage. Empty for the
   * cloud backends, which do not compute a plain SHA-256 of a multipart file;
   * use `checksum` there.
   */
  readonly sha256: string;
  /**
   * The stored file's checksum, for every backend: an exact `sha256` locally, a
   * `sha256-composite` (SHA-256 of the part SHA-256s) in the cloud, or null when
   * the provider holds no verified per-part hashes (Azure with direct transfer).
   */
  readonly checksum: FileChecksum | null;
  /** The file name the user picked. */
  readonly fileName: string;
  /**
   * The file's MIME type: detected from its content when the format has a known
   * signature, otherwise the type declared at begin. Use this, not the name.
   */
  readonly contentType: string;
  /** Stream the stored file. */
  read(): ReadableStream<Uint8Array>;
}

export interface CompleteHookInput {
  readonly file: CompletedFile;
  readonly metadata: UploadMetadata;
  readonly namespace: string;
  readonly uploadId: string;
  /** True when identical bytes were already stored for this namespace. */
  readonly deduplicated: boolean;
}

export interface CompleteResult {
  readonly uploadId: string;
  readonly fileName: string;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  /** Same as `CompletedFile.checksum`. */
  readonly checksum: FileChecksum | null;
  /** Same as `CompletedFile.contentType`. */
  readonly contentType: string;
  readonly deduplicated: boolean;
  /** Whatever `onComplete` returned. */
  readonly result: unknown;
}

/** Lowercase extension of up to 16 alphanumerics, or ''. Never a path fragment. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : '';
}

/**
 * Delete parts that do not belong in this assembly: orphans of another file
 * (a different part tag), indices beyond the part count, and wrong sizes. Only
 * ever under the lock, when no write for this upload should be in flight.
 */
async function pruneParts(store: StoreContext, uploadId: string): Promise<void> {
  const manifest = await readManifest(store, uploadId);
  if (!manifest) return;
  const tag = partTagFor(manifest.fingerprint);
  const dir = sessionKey(store.namespaceKey, uploadId);
  for (const entry of await store.storage.list(dir)) {
    const parsed = parsePartFileName(entry);
    if (!parsed) continue;
    if (parsed.tag !== tag || parsed.index > manifest.partCount) {
      await store.storage.remove(`${dir}/${entry}`);
      continue;
    }
    const key = partKey(store.namespaceKey, uploadId, parsed.index, tag);
    const index = parsed.index;
    const info = await store.storage.stat(key);
    if (!info || info.isDirectory || info.size !== expectedPartBytes(index, manifest.partBytes, manifest.totalBytes)) {
      await store.storage.remove(key);
    }
  }
}

function destinationFor(
  store: StoreContext,
  options: UploaderOptions,
  sha256: string,
  fileName: string,
): string {
  const extension = extensionOf(fileName);
  const key = options.destination
    ? options.destination({ sha256, extension, namespaceKey: store.namespaceKey, fileName })
    : `${FILES_DIR}/${store.namespaceKey}/${sha256}${extension ? `.${extension}` : ''}`;
  if (typeof key !== 'string' || key.length === 0) {
    throw new UploadError('CONFIG_INVALID', 'destination() must return a non-empty storage key');
  }
  // Anything under .parts would be reaped by the sweep as an abandoned upload.
  if (key === PARTS_DIR || key.startsWith(`${PARTS_DIR}/`) || key.startsWith(`${PARTS_DIR}\\`)) {
    throw new UploadError('CONFIG_INVALID', `destination() must not point inside ${PARTS_DIR}/`);
  }
  return key;
}

/** Whether the lock is still this request's — for cleanup that must not touch a taker's work. */
export async function stillHeld(lock: HeldLock): Promise<boolean> {
  return lock.confirm().then(
    () => true,
    () => false,
  );
}

/**
 * Publish the assembled file at `key` unless something is already there, and
 * report whether it was (`deduplicated`: the content-addressed key already held
 * these bytes). With `promoteExclusive` the check and the publish are one
 * atomic step, so two completes onto one key cannot both publish — one would
 * otherwise silently replace the other. A custom adapter without it gets a
 * check, then a move.
 */
/**
 * Assembly files of OLDER lock generations — left by holders that crashed or
 * were taken over. Each is a full copy of the file; without this they would
 * accumulate, one per takeover, until the session ends.
 */
async function removeStaleStagingFiles(store: StoreContext, uploadId: string, generation: number): Promise<void> {
  const dir = sessionKey(store.namespaceKey, uploadId);
  for (const entry of await store.storage.list(dir).catch(() => [] as string[])) {
    const match = /^assembled\.([0-9]{1,15})\.bin$/.exec(entry);
    if (match && Number(match[1]) < generation) await store.storage.remove(`${dir}/${entry}`).catch(() => undefined);
  }
}

async function promoteUnlessPresent(store: StoreContext, staging: string, key: string): Promise<boolean> {
  const outcome = store.storage.promoteExclusive
    ? await store.storage.promoteExclusive(staging, key)
    : (await store.storage.stat(key))
      ? 'exists'
      : (await store.storage.promote(staging, key), 'moved');
  if (outcome === 'exists') await store.storage.remove(staging);
  return outcome === 'exists';
}

export async function completeUpload(
  store: StoreContext,
  uploadId: string,
  namespace: string,
  options: UploaderOptions,
): Promise<CompleteResult> {
  // Checked BEFORE locking: creating the lock file would otherwise create an
  // empty session directory for an upload that never existed.
  if (!(await readManifest(store, uploadId))) {
    throw new UploadError('NO_SESSION', `No upload in progress for "${uploadId}"`);
  }
  const lock = await acquireLock(store, uploadId, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);

  const staging = stagingKeyForGeneration(store.namespaceKey, uploadId, lock.generation);
  let stagingExists = false;

  try {
    await pruneParts(store, uploadId);
    await removeStaleStagingFiles(store, uploadId, lock.generation);

    const session = await readSession(store, uploadId);
    const { manifest } = session;
    if (!session.complete) {
      throw new UploadError('INCOMPLETE', `${session.missingParts.length} part(s) have not been uploaded yet.`, {
        missingParts: session.missingParts.slice(0, 50),
      });
    }

    const tag = partTagFor(manifest.fingerprint);
    // One read serves both checks below; part 1 is the start of the file.
    const headBytes = options.headBytes ?? DEFAULT_HEAD_BYTES;
    const head = await store.storage.readHead(
      partKey(store.namespaceKey, uploadId, 1, tag),
      Math.max(headBytes, SIGNATURE_BYTES),
    );
    // allowedTypes check 2 of 2: the CONTENT, not the name. Parts are kept on a
    // refusal, like validateHead: the policy may be what is wrong.
    const declaredType = manifest.contentType ?? declaredTypeFor(manifest.fileName, undefined);
    const contentType = assertContentAllowed(store.config.allowedTypes, head, manifest.fileName, declaredType);

    if (options.validateHead) {
      try {
        await options.validateHead(head.subarray(0, headBytes), {
          fileName: manifest.fileName,
          totalBytes: manifest.totalBytes,
          metadata: manifest.metadata,
          namespace,
        });
      } catch (err) {
        // Parts deliberately kept: the check may be wrong, and the sweep
        // reclaims them otherwise.
        if (err instanceof UploadError) throw err;
        throw new UploadError('REJECTED', err instanceof Error ? err.message : 'The file was rejected.');
      }
    }

    const partKeys = Array.from({ length: manifest.partCount }, (_, i) =>
      partKey(store.namespaceKey, uploadId, i + 1, tag),
    );
    stagingExists = true;
    const assembly = await store.storage.assemble(partKeys, staging);
    if (assembly.bytesWritten !== manifest.totalBytes) {
      // Upstream size checks should make this unreachable. If it fires one of them
      // is wrong, and storing the file would record bytes that do not match the
      // declared size — so fail loudly instead.
      throw new UploadError(
        'PART_LENGTH_MISMATCH',
        `Assembled ${assembly.bytesWritten} bytes but the upload declared ${manifest.totalBytes}.`,
      );
    }

    // Assembly is the long step: make sure the lock is still ours (a request
    // that took it over would publish too) and refresh it, before publishing —
    // and that the upload still exists: a lock rewrite that landed after a
    // taker finished and removed the session must not revive it.
    await lock.refresh();
    if (!(await readManifest(store, uploadId))) {
      throw new UploadError('COMPLETE_IN_PROGRESS', 'Another request finished this upload.');
    }
    const key = destinationFor(store, options, assembly.sha256, manifest.fileName);
    const deduplicated = await promoteUnlessPresent(store, staging, key);
    stagingExists = false;
    // An existing file is "the same bytes" only at the default, content-addressed
    // key. At a custom destination it is another upload's file: refused, as on
    // cloud storage, instead of handing this upload someone else's bytes.
    if (deduplicated && options.destination) throw destinationExists();

    const checksum: FileChecksum = { type: 'sha256', value: assembly.sha256 };
    const file: CompletedFile = {
      key,
      localPath: store.storage.localPath?.(key),
      size: assembly.bytesWritten,
      sha256: assembly.sha256,
      checksum,
      fileName: manifest.fileName,
      contentType,
      read: () => store.storage.openRead(key),
    };

    let result: unknown = null;
    if (options.onComplete) {
      await lock.refresh();
      try {
        result = (await options.onComplete({ file, metadata: manifest.metadata, namespace, uploadId, deduplicated })) ?? null;
      } catch (err) {
        // A file nothing has recorded would never be deleted, so at a custom
        // destination (one upload, one key) it is removed, while the lock is
        // still ours. At the default content-addressed key it STAYS: another
        // upload of the same bytes in this namespace may already have found it
        // (deduplicated) and recorded it — deleting it would lose that record's
        // file. A retry finds it again. The parts are kept either way.
        if (!deduplicated && options.destination && (await stillHeld(lock))) {
          await store.storage.remove(key).catch(() => undefined);
        }
        throw err;
      }
    }

    // The parts go only while the lock is still ours: a request that took over
    // during a long onComplete may be assembling them right now. The file is
    // stored and recorded, so a cleanup failure is not the caller's: the sweep
    // reclaims what is left.
    if (await stillHeld(lock)) await store.storage.removeTree(sessionKey(store.namespaceKey, uploadId)).catch(() => undefined);
    return {
      uploadId,
      fileName: manifest.fileName,
      key,
      size: assembly.bytesWritten,
      sha256: assembly.sha256,
      checksum,
      contentType,
      deduplicated,
      result,
    };
  } finally {
    if (stagingExists) await store.storage.remove(staging).catch(() => undefined);
    // Absent after a successful complete (the session tree is gone): a no-op.
    await lock.release().catch(() => undefined);
  }
}
