// ---------------------------------------------------------------------------
// uploader.ts — the framework-free server API
// ---------------------------------------------------------------------------
//
// `createUploader` is what the Next.js route handlers call, and what an
// application can call directly. Every method takes the caller's namespace, so
// one user can never read, resume, complete or discard another user's upload.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { expectedPartBytes, partCountFor } from '../core/arithmetic.js';
import { UploadError } from '../core/errors.js';
import { describeByteSize } from '../core/format.js';
import { manifestKey, namespaceDirKey, partKey, sessionKey } from '../core/layout.js';
import { type UploadManifest, type UploadMetadata, type UploadSession, summariseSession } from '../core/session.js';
import { assertSafeUploadId } from '../core/slug.js';
import { FsStorage } from '../storage/fs-storage.js';
import type { DirectPartRequest } from '../storage/cloud/types.js';
import { cloudBackendFor } from './cloud-backends.js';
import { cloudSweepRelease, discardCloudUpload } from './cloud-control.js';
import { completeCloudUpload, openCloudSession, presignCloudPart, storeCloudPart } from './cloud-flow.js';
import { completeUpload, DEFAULT_LOCK_STALE_MS, discardUnderLock, type CompleteHookInput, type CompleteResult } from './complete.js';
import { type ConfigOverrides, type ResolvedConfig, resolveConfig } from './config.js';
import { assertDeclaredTypeAllowed, declaredTypeFor } from './file-types.js';
import { namespaceKeyFor, partTagFor, uploadIdFor } from './namespace.js';
import { type ResolvedStorage, type StorageOverrides, resolveStorage } from './storage-config.js';
import { listVerifiedParts, readManifest, readSession, findSession, type StoreContext } from './store.js';
import { sweepStaleUploads, type SweepResult } from './sweep.js';

export interface UploaderOptions extends ConfigOverrides, StorageOverrides {
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
   * Storage key for a completed file. Default (local):
   * `files/<namespace hash>/<sha256>.<ext>` — content-addressed and per-namespace.
   * Cloud backends call it when the upload BEGINS, before any byte exists, so
   * `sha256` is '' there and the default is
   * `files/<namespace hash>/<uploadId>-<sessionId>.<ext>`. A cloud key MUST be
   * unique per upload — build it from `sessionId` (or `uploadId` and
   * `namespaceKey`); a commit onto an object this upload did not create is
   * refused with DESTINATION_EXISTS.
   */
  destination?: (info: {
    sha256: string;
    extension: string;
    namespaceKey: string;
    fileName: string;
    uploadId?: string;
    /** Cloud only: random, minted per new upload session; kept on resume. */
    sessionId?: string;
  }) => string;
  /**
   * Remove expired unfinished uploads when a new one begins. Default: true for
   * local storage, false for cloud storage (where it would cost a request per
   * stored object on every upload start — sweep on a schedule instead).
   */
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
  /** The browser's `File.type`. Optional; the extension's usual type is used when absent. */
  readonly contentType?: string;
}

export interface PutPartInput {
  readonly uploadId: string;
  readonly index: number;
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
  /**
   * Lowercase hex SHA-256 of the part, computed by the client BEFORE sending.
   * When present, a part whose received bytes hash differently is refused and
   * nothing is written. Optional: browsers can only compute it in a secure
   * context (HTTPS or localhost).
   */
  readonly sha256?: string;
}

export interface PutPartResult {
  readonly uploadId: string;
  readonly index: number;
  readonly receivedBytes: number;
  readonly missingCount: number;
  /** True when this exact part was already stored — the write was a no-op. */
  readonly alreadyPresent: boolean;
}

/** Direct transfer: ask for a signed URL to send one part straight to the storage. */
export interface PresignPartInput {
  readonly uploadId: string;
  readonly index: number;
  readonly fingerprint: string;
  /** Lowercase hex SHA-256 of the part. Signed into the request; the storage verifies it. */
  readonly sha256: string;
  /** Base64 MD5 of the part — required by azure_blob, which verifies MD5 per block. */
  readonly md5?: string;
}

export interface PresignPartResult extends DirectPartRequest {
  readonly index: number;
  readonly length: number;
}

/** How the browser should send parts, for the `begin` response. */
export interface TransferInfo {
  readonly transfer: ResolvedStorage['transfer'];
  readonly storage: ResolvedStorage['kind'];
  /** Checksums the browser must compute per part for direct transfer. */
  readonly directChecksums: readonly ('sha256' | 'md5')[];
}

export interface Uploader {
  config(): ResolvedConfig;
  /** The storage kind and transfer mode in force, and what direct transfer needs. */
  transferInfo(): Promise<TransferInfo>;
  /** Direct transfer only: a short-lived signed request for one part. */
  presignPart(ctx: UploadContext, input: PresignPartInput): Promise<PresignPartResult>;
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

  /**
   * Configuration is resolved per call, so a changed .env value is honoured.
   * Cloud clients are NOT recreated per call — see cloud-backends.ts.
   */
  async function storeFor(namespaceKey: string): Promise<StoreContext> {
    const config = resolveConfig(options);
    const storageConfig = resolveStorage(options, config);
    if (storageConfig.backend) {
      const backend = await cloudBackendFor(storageConfig.backend);
      return { config, storageConfig, storage: backend.control, backend, namespaceKey };
    }
    // `!= null`: a JavaScript caller's `storage: null` falls back to the filesystem, as in 0.2.
    const storage = options.storage != null && typeof options.storage === 'object' ? options.storage : new FsStorage(config.dir);
    return { config, storageConfig, storage, namespaceKey };
  }

  function contextFor(ctx: UploadContext): Promise<StoreContext> {
    return storeFor(namespaceKeyFor(ctx.namespace));
  }

  /** Releases the provider's side of a stale cloud session before its files go. */
  function sweepFor(store: StoreContext): Promise<SweepResult> {
    return sweepStaleUploads(store.storage, store.config.partTtlMs, store.backend ? cloudSweepRelease(store.backend) : undefined);
  }

  function checkedId(uploadId: string): string {
    assertSafeUploadId(uploadId);
    return uploadId;
  }

  async function begin(ctx: UploadContext, input: BeginInput) {
    const store = await contextFor(ctx);
    const { config } = store;

    if (typeof input.fileName !== 'string' || input.fileName.length === 0 || input.fileName.length > 1024) {
      throw new UploadError('INVALID_REQUEST', 'fileName must be a string of 1 to 1024 characters');
    }
    // The name is stored and shown in messages, never used as a path, but a
    // control character in it has no legitimate use.
    if (/[\u0000-\u001f\u007f]/.test(input.fileName)) {
      throw new UploadError('INVALID_NAME', 'fileName must not contain control characters');
    }
    if (typeof input.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(input.fingerprint)) {
      throw new UploadError('INVALID_REQUEST', 'fingerprint must be 1–200 characters of [A-Za-z0-9._:-]');
    }
    const { totalBytes } = input;
    if (totalBytes === 0) {
      throw new UploadError('INVALID_REQUEST', `"${input.fileName}" is empty. Empty files cannot be uploaded.`);
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new UploadError('INVALID_REQUEST', 'totalBytes must be a positive integer');
    }
    if (totalBytes > config.maxFileBytes) {
      throw new UploadError(
        'FILE_TOO_LARGE',
        `This file is ${describeByteSize(totalBytes)}; the maximum upload size is ${describeByteSize(config.maxFileBytes)}.`,
        { maxFileBytes: config.maxFileBytes },
      );
    }
    if (input.contentType !== undefined && (typeof input.contentType !== 'string' || input.contentType.length > 255)) {
      throw new UploadError('INVALID_REQUEST', 'contentType must be a string of at most 255 characters');
    }
    // Check 1 of 2: refused here, before any part is sent. The content itself is
    // checked at complete (see file-types.ts) — the declared type is only a name.
    const contentType = declaredTypeFor(input.fileName, input.contentType);
    assertDeclaredTypeAllowed(config.allowedTypes, input.fileName, contentType);
    const metadata = validateMetadata(input.metadata, maxMetadataBytes);
    // SHA-256 of name + size + MIME type + content fingerprint: the upload id and
    // its temporary folder. Same file -> same folder (resume); any difference ->
    // a different folder, so two files can never mix parts.
    const identity = { fileName: input.fileName, totalBytes, contentType, fingerprint: input.fingerprint };
    const uploadId = uploadIdFor(identity);
    const { partBytes } = config;

    // Default: on for local storage, OFF for cloud storage. The sweep lists every
    // session of every user; on a filesystem that is cheap, on S3 / Azure it is
    // a request per object on every upload start. Cloud deployments sweep on a
    // schedule (uploader.sweep()) and with the provider's lifecycle rules.
    if (options.sweepOnBegin ?? !store.backend) {
      // Opportunistic and best-effort: a sweep problem must never block a new
      // upload. This is the caller that works with no operator action at all.
      await sweepFor(store).catch(() => undefined);
    }

    const resume = async (existing: UploadManifest) => {
      // The id is a hash of exactly these fields, so they match unless the
      // manifest was edited or written by an older version. REFUSE, never reset:
      // discarding the existing parts would turn a mismatch into data loss.
      // The part size is deliberately NOT compared: it is frozen in the manifest
      // and the client slices by the value returned here, so a changed setting
      // resumes safely on the original boundaries.
      const sameFile =
        existing.fileName === identity.fileName &&
        existing.totalBytes === identity.totalBytes &&
        existing.fingerprint === identity.fingerprint &&
        (existing.contentType ?? contentType) === identity.contentType;
      if (!sameFile) {
        throw new UploadError(
          'NAME_IN_USE',
          `The unfinished upload stored under this id does not describe "${input.fileName}". ` +
            'Discard it and start again.',
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

    // Cloud: the provider's multipart session is opened first, because its id
    // (S3's UploadId) must be in the manifest. Its final key is fixed now.
    const cloud = store.backend ? await openCloudSession(store, options, uploadId, input.fileName, contentType) : undefined;
    const dropCloudSession = async () => {
      if (cloud && store.backend) await store.backend.abortSession(cloud).catch(() => undefined);
    };

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
      contentType,
      ...(cloud ? { cloud } : {}),
    };

    // A provider session no manifest references would be billed until a
    // lifecycle rule removes it, so it is dropped on every path that loses it.
    const outcome = await store.storage
      .createExclusive(manifestKey(store.namespaceKey, uploadId), JSON.stringify(manifest, null, 2))
      .catch(async (err: unknown) => {
        await dropCloudSession();
        throw err;
      });
    if (outcome === 'exists') {
      // Another request created it between the read and the write. Take the
      // resume path rather than overwriting someone else's session.
      await dropCloudSession();
      const raced = await readManifest(store, uploadId);
      if (raced) return resume(raced);
      throw new UploadError('NAME_IN_USE', 'Another request is starting this upload right now. Retry.', { uploadId });
    }
    return { session: summariseSession(manifest, []), created: true };
  }

  async function putPart(ctx: UploadContext, input: PutPartInput): Promise<PutPartResult> {
    const store = await contextFor(ctx);
    const uploadId = checkedId(input.uploadId);
    const { index, bytes } = input;
    const manifest = await manifestForPart(store, uploadId, index, input.fingerprint);
    const expected = expectedPartBytes(index, manifest.partBytes, manifest.totalBytes);
    if (bytes.byteLength !== expected) {
      throw new UploadError('PART_LENGTH_MISMATCH', `Part ${index} must be ${expected} bytes, received ${bytes.byteLength}.`);
    }
    // The length check cannot catch bytes that arrive at the right length but
    // with the wrong content — which a WebKit build was found doing in testing:
    // every part carried part 1's bytes, every size check passed, and the upload
    // "succeeded". The client's checksum turns that into a loud, retryable error.
    // Hashed when it is checked or needed: cloud storage records every part's SHA-256.
    const actual = input.sha256 !== undefined || store.backend ? createHash('sha256').update(bytes).digest('hex') : '';
    if (input.sha256 !== undefined && actual !== input.sha256) {
      throw new UploadError(
        'PART_CHECKSUM_MISMATCH',
        `Part ${index} arrived with different content from what was sent (checksum mismatch). Nothing was stored; send the part again.`,
      );
    }

    if (store.backend) {
      // The provider holds the part; the server-verified SHA-256 goes with it
      // (S3 checks it again; Azure gets it in the block id, plus an MD5 check).
      await storeCloudPart(store, manifest, index, bytes, actual, options.headBytes);
      const stored = summariseSession(manifest, await listVerifiedParts(store, manifest));
      return { uploadId, index, receivedBytes: stored.receivedBytes, missingCount: stored.missingParts.length, alreadyPresent: false };
    }

    // Named with this upload's part tag, so a stray part file of anything else
    // occupies a DIFFERENT key and can never satisfy the "already present"
    // check below with the wrong bytes (a second line of defence: different
    // files already get different session directories).
    const key = partKey(store.namespaceKey, uploadId, index, partTagFor(manifest.fingerprint));
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

  /** The manifest a part belongs to, after every check that does not need the bytes. */
  async function manifestForPart(store: StoreContext, uploadId: string, index: number, fingerprint: string): Promise<UploadManifest> {
    const manifest = await readManifest(store, uploadId);
    if (!manifest) throw new UploadError('NO_SESSION', `No upload in progress for "${uploadId}"`);
    // Checked on EVERY part, not only at begin: a client refused at begin still
    // knows the upload id and could otherwise write into another file's session.
    if (manifest.fingerprint !== fingerprint) {
      throw new UploadError('FINGERPRINT_MISMATCH', 'This part belongs to a different file than the upload in progress.');
    }
    if (manifest.instanceId !== store.config.instanceId) {
      throw new UploadError('WRONG_INSTANCE', `This upload's parts live on server instance "${manifest.instanceId}".`);
    }
    if (!Number.isInteger(index) || index < 1 || index > manifest.partCount) {
      throw new UploadError('PART_OUT_OF_RANGE', `Part ${index} is outside 1..${manifest.partCount}`);
    }
    if (manifest.committed) throw new UploadError('COMPLETE_IN_PROGRESS', 'This upload has already been committed.');
    return manifest;
  }

  async function presignPart(ctx: UploadContext, input: PresignPartInput): Promise<PresignPartResult> {
    const store = await contextFor(ctx);
    // Refused unless the operator chose direct transfer: a server configured for
    // proxy transfer must not hand out URLs that bypass it.
    if (!store.backend || store.storageConfig.transfer !== 'direct') {
      throw new UploadError('INVALID_REQUEST', 'Direct transfer is not enabled on this server; send parts through it.');
    }
    if (!store.backend.supportsDirect) {
      throw new UploadError('CONFIG_INVALID', 'This storage configuration cannot sign direct-transfer URLs.');
    }
    if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new UploadError('INVALID_REQUEST', 'sha256 must be the part\'s lowercase hex SHA-256');
    }
    const needsMd5 = store.backend.directChecksums.includes('md5');
    if (needsMd5 && (typeof input.md5 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(input.md5))) {
      throw new UploadError('INVALID_REQUEST', 'md5 must be the part\'s base64 MD5 for this storage');
    }
    const uploadId = checkedId(input.uploadId);
    const manifest = await manifestForPart(store, uploadId, input.index, input.fingerprint);
    return presignCloudPart(store, manifest, input.index, input.sha256, needsMd5 ? input.md5 : undefined);
  }

  async function list(ctx: UploadContext): Promise<UploadSession[]> {
    const store = await contextFor(ctx);
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
    transferInfo: async () => {
      const config = resolveConfig(options);
      const storage = resolveStorage(options, config);
      const backend = storage.backend ? await cloudBackendFor(storage.backend) : undefined;
      return {
        transfer: storage.transfer,
        storage: storage.kind,
        directChecksums: storage.transfer === 'direct' && backend ? backend.directChecksums : [],
      };
    },
    presignPart,
    begin,
    putPart,
    list,
    status: async (ctx, uploadId) => readSession(await contextFor(ctx), checkedId(uploadId)),
    complete: async (ctx, uploadId) => {
      const store = await contextFor(ctx);
      const id = checkedId(uploadId);
      return store.backend
        ? completeCloudUpload(store, id, ctx.namespace, options)
        : completeUpload(store, id, ctx.namespace, options);
    },
    discard: async (ctx, uploadId) => {
      const store = await contextFor(ctx);
      const id = checkedId(uploadId);
      await discardUnderLock(store, id, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS, () =>
        store.backend ? discardCloudUpload(store, id) : store.storage.removeTree(sessionKey(store.namespaceKey, id)),
      );
    },
    // The sweep spans every namespace; the namespace key here is unused.
    sweep: async () => sweepFor(await storeFor('')),
  };
}
