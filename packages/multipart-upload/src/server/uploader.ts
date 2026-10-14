// ---------------------------------------------------------------------------
// uploader.ts — the framework-free server API
// ---------------------------------------------------------------------------
//
// `createUploader` is what the Next.js route handlers call, and what an
// application can call directly. Every method takes the caller's namespace, so
// one user can never read, resume, complete or discard another user's upload.
// ---------------------------------------------------------------------------

import { expectedPartBytes, partCountFor } from '../core/arithmetic.js';
import { UploadError } from '../core/errors.js';
import { lockKey, manifestKey, namespaceDirKey, partKey, sessionKey } from '../core/layout.js';
import { type UploadManifest, type UploadMetadata, type UploadSession, manifestMatches, summariseSession } from '../core/session.js';
import { assertSafeUploadId, uploadIdForFileName } from '../core/slug.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { FsStorage } from '../storage/fs-storage.js';
import { completeUpload, DEFAULT_LOCK_STALE_MS, type CompleteHookInput, type CompleteResult } from './complete.js';
import { type ConfigOverrides, type ResolvedConfig, resolveConfig } from './config.js';
import { namespaceKeyFor } from './namespace.js';
import { listVerifiedParts, readManifest, readSession, findSession, type StoreContext } from './store.js';
import { sweepStaleUploads, type SweepResult } from './sweep.js';

export interface UploaderOptions extends ConfigOverrides {
  /** Storage backend. Defaults to the filesystem at MULTIPART_UPLOAD_DIR. */
  storage?: StorageAdapter;
  /** Largest JSON metadata object accepted at begin. Default 16 KB. */
  maxMetadataBytes?: number;
  /** Bytes of the file's start passed to `validateHead`. Default 64 KB. */
  headBytes?: number;
  /**
   * Inspect the start of the file before it is assembled — e.g. check magic
   * bytes. Throw to refuse it; the client gets 422 and the parts are KEPT, so
   * nothing has to be uploaded again if the check was wrong.
   */
  validateHead?: (
    head: Uint8Array,
    info: { fileName: string; totalBytes: number; metadata: UploadMetadata; namespace: string },
  ) => void | Promise<void>;
  /**
   * Called once the file is assembled and stored. Its return value is sent to
   * the client as `result`, so it must be JSON-serialisable. Throw to fail the
   * upload: a newly stored file is then removed and the parts are kept.
   */
  onComplete?: (input: CompleteHookInput) => unknown | Promise<unknown>;
  /**
   * Storage key for a completed file. Default:
   * `files/<namespace hash>/<sha256>.<ext>` — content-addressed and per-namespace.
   */
  destination?: (info: { sha256: string; extension: string; namespaceKey: string; fileName: string }) => string;
  /** Remove expired unfinished uploads when a new one begins. Default true. */
  sweepOnBegin?: boolean;
  /** A `complete` lock older than this is considered abandoned. Default 15 min. */
  lockStaleMs?: number;
}

export interface UploadContext {
  /** Who is uploading — usually a user id. Uploads are isolated per namespace. */
  readonly namespace: string;
}

export interface BeginInput {
  readonly fileName: string;
  readonly totalBytes: number;
  readonly fingerprint: string;
  readonly metadata?: UploadMetadata;
}

export interface PutPartInput {
  readonly uploadId: string;
  readonly index: number;
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
}

export interface PutPartResult {
  readonly uploadId: string;
  readonly index: number;
  readonly receivedBytes: number;
  readonly missingCount: number;
  /** True when this exact part was already stored — the write was a no-op. */
  readonly alreadyPresent: boolean;
}

export interface Uploader {
  config(): ResolvedConfig;
  begin(ctx: UploadContext, input: BeginInput): Promise<{ session: UploadSession; created: boolean }>;
  status(ctx: UploadContext, uploadId: string): Promise<UploadSession>;
  list(ctx: UploadContext): Promise<UploadSession[]>;
  putPart(ctx: UploadContext, input: PutPartInput): Promise<PutPartResult>;
  complete(ctx: UploadContext, uploadId: string): Promise<CompleteResult>;
  discard(ctx: UploadContext, uploadId: string): Promise<void>;
  /** Remove unfinished uploads untouched for longer than the TTL. No timers: call it yourself, or rely on `sweepOnBegin`. */
  sweep(): Promise<SweepResult>;
}

const DEFAULT_MAX_METADATA_BYTES = 16 * 1024;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function validateMetadata(metadata: unknown, limit: number): UploadMetadata {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new UploadError('INVALID_REQUEST', 'metadata must be a JSON object');
  }
  const size = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
  if (size > limit) {
    throw new UploadError('METADATA_TOO_LARGE', `metadata is ${size} bytes; the limit is ${limit}`, { limit });
  }
  return metadata as UploadMetadata;
}

export function createUploader(options: UploaderOptions = {}): Uploader {
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;

  /** Configuration is resolved per call, so a changed .env value is honoured. */
  function contextFor(ctx: UploadContext): StoreContext {
    const config = resolveConfig(options);
    return {
      config,
      storage: options.storage ?? new FsStorage(config.dir),
      namespaceKey: namespaceKeyFor(ctx.namespace),
    };
  }

  function checkedId(uploadId: string): string {
    assertSafeUploadId(uploadId);
    return uploadId;
  }

  async function begin(ctx: UploadContext, input: BeginInput) {
    const store = contextFor(ctx);
    const { config } = store;

    if (typeof input.fileName !== 'string' || input.fileName.length === 0 || input.fileName.length > 1024) {
      throw new UploadError('INVALID_REQUEST', 'fileName must be a string of 1 to 1024 characters');
    }
    if (typeof input.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(input.fingerprint)) {
      throw new UploadError('INVALID_REQUEST', 'fingerprint must be 1–200 characters of [A-Za-z0-9._:-]');
    }
    const { totalBytes } = input;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new UploadError('INVALID_REQUEST', 'totalBytes must be a positive integer');
    }
    if (totalBytes > config.maxFileBytes) {
      throw new UploadError(
        'FILE_TOO_LARGE',
        `File is ${totalBytes} bytes; the maximum upload size is ${config.maxFileBytes} bytes.`,
        { maxFileBytes: config.maxFileBytes },
      );
    }
    const metadata = validateMetadata(input.metadata, maxMetadataBytes);
    const uploadId = uploadIdForFileName(input.fileName);
    const { partBytes } = config;
    const candidate = { totalBytes, partBytes, fingerprint: input.fingerprint };

    if (options.sweepOnBegin !== false) {
      // Opportunistic and best-effort: a sweep problem must never block a new
      // upload. This is the caller that works with no operator action at all.
      await sweepStaleUploads(store.storage, config.partTtlMs).catch(() => undefined);
    }

    const resume = async (existing: UploadManifest) => {
      if (!manifestMatches(existing, candidate)) {
        // REFUSE, never reset: silently discarding the first upload's parts would
        // turn a naming collision into data loss.
        throw new UploadError(
          'NAME_IN_USE',
          `An unfinished upload of "${existing.fileName}" already uses this name, and it is a different ` +
            `file from "${input.fileName}". Rename the file or discard the other upload first.`,
          { uploadId },
        );
      }
      if (existing.instanceId !== config.instanceId) {
        throw new UploadError(
          'WRONG_INSTANCE',
          `This upload was started on server instance "${existing.instanceId}" and its parts are not ` +
            `reachable from "${config.instanceId}".`,
        );
      }
      return { session: summariseSession(existing, await listVerifiedParts(store, existing)), created: false };
    };

    const existing = await readManifest(store, uploadId);
    if (existing) return resume(existing);

    const manifest: UploadManifest = {
      v: 1,
      uploadId,
      namespaceKey: store.namespaceKey,
      fileName: input.fileName,
      totalBytes,
      partBytes,
      partCount: partCountFor(totalBytes, partBytes),
      fingerprint: input.fingerprint,
      instanceId: config.instanceId,
      createdAt: new Date().toISOString(),
      metadata,
    };

    const outcome = await store.storage.createExclusive(
      manifestKey(store.namespaceKey, uploadId),
      JSON.stringify(manifest, null, 2),
    );
    if (outcome === 'exists') {
      // Another request created it between the read and the write. Take the
      // resume path rather than overwriting someone else's session.
      const raced = await readManifest(store, uploadId);
      if (raced) return resume(raced);
      throw new UploadError('NAME_IN_USE', 'Another upload claimed this name a moment ago. Retry.', { uploadId });
    }
    return { session: summariseSession(manifest, []), created: true };
  }

  async function putPart(ctx: UploadContext, input: PutPartInput): Promise<PutPartResult> {
    const store = contextFor(ctx);
    const uploadId = checkedId(input.uploadId);
    const { index, bytes } = input;

    const manifest = await readManifest(store, uploadId);
    if (!manifest) throw new UploadError('NO_SESSION', `No upload in progress for "${uploadId}"`);

    // Checked on EVERY part, not only at begin: a client refused at begin still
    // knows the upload id and could otherwise write into another file's session.
    if (manifest.fingerprint !== input.fingerprint) {
      throw new UploadError('FINGERPRINT_MISMATCH', 'This part belongs to a different file than the upload in progress.');
    }
    if (manifest.instanceId !== store.config.instanceId) {
      throw new UploadError('WRONG_INSTANCE', `This upload's parts live on server instance "${manifest.instanceId}".`);
    }
    if (!Number.isInteger(index) || index < 1 || index > manifest.partCount) {
      throw new UploadError('PART_OUT_OF_RANGE', `Part ${index} is outside 1..${manifest.partCount}`);
    }
    const expected = expectedPartBytes(index, manifest.partBytes, manifest.totalBytes);
    if (bytes.byteLength !== expected) {
      throw new UploadError('PART_LENGTH_MISMATCH', `Part ${index} must be ${expected} bytes, received ${bytes.byteLength}.`);
    }

    const key = partKey(store.namespaceKey, uploadId, index);
    let alreadyPresent = false;

    // createExclusive is the concurrency control: exactly one writer wins, so
    // two attempts at one index cannot interleave into a correctly-sized but
    // spliced file — a corruption the size check could never catch.
    if ((await store.storage.createExclusive(key, bytes)) === 'exists') {
      const info = await store.storage.stat(key);
      if (info && !info.isDirectory && info.size === expected) {
        // Re-sending a stored part is idempotent SUCCESS, which is what makes a
        // retry after an ambiguous failure safe.
        alreadyPresent = true;
      } else {
        // A short file from a write that died. Replace it — but if another writer
        // has since claimed the name, do not fight: report a retryable conflict.
        await store.storage.remove(key).catch(() => undefined);
        if ((await store.storage.createExclusive(key, bytes)) === 'exists') {
          throw new UploadError('PART_IN_FLIGHT', `Part ${index} is being written by another request. Retry it.`);
        }
      }
    }

    const session = summariseSession(manifest, await listVerifiedParts(store, manifest));
    return {
      uploadId,
      index,
      receivedBytes: session.receivedBytes,
      missingCount: session.missingParts.length,
      alreadyPresent,
    };
  }

  async function list(ctx: UploadContext): Promise<UploadSession[]> {
    const store = contextFor(ctx);
    const ids = await store.storage.list(namespaceDirKey(store.namespaceKey));
    const sessions: UploadSession[] = [];
    for (const id of ids) {
      // An entry this library did not create is skipped rather than thrown on,
      // so one stray directory cannot break the listing.
      try {
        assertSafeUploadId(id);
        const session = await findSession(store, id);
        if (session) sessions.push(session);
      } catch {
        continue;
      }
    }
    return sessions;
  }

  return {
    config: () => resolveConfig(options),
    begin,
    putPart,
    list,
    status: (ctx, uploadId) => readSession(contextFor(ctx), checkedId(uploadId)),
    complete: (ctx, uploadId) =>
      completeUpload(contextFor(ctx), checkedId(uploadId), ctx.namespace, options),
    discard: async (ctx, uploadId) => {
      const store = contextFor(ctx);
      const id = checkedId(uploadId);
      // Deleting the parts while `complete` is streaming them would turn a
      // successful finish into a half-assembled failure. A lock older than
      // lockStaleMs belonged to a process that died, and is ignored.
      const lock = await store.storage.stat(lockKey(store.namespaceKey, id));
      if (lock && Date.now() - lock.modifiedMs < (options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS)) {
        throw new UploadError('COMPLETE_IN_PROGRESS', 'This upload is being finalised and cannot be discarded now.');
      }
      await store.storage.removeTree(sessionKey(store.namespaceKey, id));
    },
    sweep: async () => {
      const config = resolveConfig(options);
      return sweepStaleUploads(options.storage ?? new FsStorage(config.dir), config.partTtlMs);
    },
  };
}
