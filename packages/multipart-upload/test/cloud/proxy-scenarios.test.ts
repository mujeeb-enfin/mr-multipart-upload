// ---------------------------------------------------------------------------
// proxy-scenarios.test.ts — multipart uploads through the server, per backend
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. Every multipart scenario the local filesystem supports
// must hold on aws_s3, minio and azure_blob: byte-exact storage (read back and
// hashed), resume from the provider's own part list, out-of-order and repeated
// parts, every refusal storing nothing, per-user isolation, the content check
// running BEFORE commit, a failed onComplete retried without re-uploading,
// discard and the sweep releasing the provider's multipart session.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UploadError } from '../../src/core/errors.js';
import { manifestKey } from '../../src/core/layout.js';
import type { UploadManifest } from '../../src/core/session.js';
import { namespaceKeyFor } from '../../src/server/namespace.js';
import { createUploader, type Uploader, type UploaderOptions } from '../../src/server/uploader.js';
import { clearEnv, partOf, patternBytes } from '../helpers.js';
import {
  AVAILABLE,
  CLOUD_PART_BYTES,
  MIB,
  azureBlob,
  backendFor,
  createBucket,
  deleteBucket,
  expectedComposite,
  openS3MultipartUploads,
  readAll,
  sha256,
  storageOptions,
  uniqueBucketName,
  wait,
  type CloudKind,
} from './cloud-helpers.js';

const ALICE = { namespace: 'user-alice' };
const BOB = { namespace: 'user-bob' };
const SIZE = 2 * CLOUD_PART_BYTES + 777; // 3 parts: 5 MiB, 5 MiB, 777 B
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXE = [0x4d, 0x5a, 0x90, 0x00];

function fileOf(size: number, seed: number, signature?: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = patternBytes(size, seed);
  if (signature) bytes.set(signature);
  return bytes;
}

function partsOf(size: number): number[] {
  return Array.from({ length: Math.ceil(size / CLOUD_PART_BYTES) }, (_, i) => i + 1);
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof UploadError ? err.code : `unexpected: ${String(err)}`;
  }
}

describe.skipIf(AVAILABLE.length === 0)('cloud backends — proxy transfer', () => {
  describe.each(AVAILABLE)('%s', (kind: CloudKind) => {
    const bucket = uniqueBucketName(`proxy-${kind.replace('_', '')}`);
    const base = (extra: UploaderOptions = {}): UploaderOptions => ({
      ...storageOptions(kind, bucket),
      partBytes: CLOUD_PART_BYTES,
      sweepOnBegin: false,
      ...extra,
    });
    const uploader = (extra: UploaderOptions = {}): Uploader => createUploader(base(extra));

    async function sendParts(up: Uploader, ctx: { namespace: string }, id: string, bytes: Uint8Array<ArrayBuffer>, fp: string, indices: number[]) {
      for (const index of indices) await up.putPart(ctx, { uploadId: id, index, bytes: partOf(bytes, index, CLOUD_PART_BYTES), fingerprint: fp });
    }

    /**
     * What a released proxy session leaves at the provider. S3: nothing — the
     * multipart upload is aborted. Azure: no stored blob; the uncommitted blocks
     * stay until Azure discards them (7 days), because deleting the blob could
     * destroy a file another upload commits at the same key in the meantime.
     */
    async function expectProviderReleased(ref: UploadManifest['cloud']) {
      const session = ref as NonNullable<UploadManifest['cloud']>;
      if (kind === 'azure_blob') {
        expect(await (await azureBlob(bucket, session.key)).exists()).toBe(false);
      } else {
        expect(await (await backendFor(base())).listParts(session)).toEqual([]);
      }
    }

    /** Leave what a server that stopped mid-complete leaves: the marker, the provider commit, no `committed`. */
    async function commitThenCrash(manifest: UploadManifest) {
      const backend = await backendFor(base());
      const session = manifest.cloud as NonNullable<UploadManifest['cloud']>;
      const marked = { ...manifest, commitStartedAt: new Date().toISOString() };
      await backend.control.write?.(manifestKey(namespaceKeyFor(ALICE.namespace), manifest.uploadId), JSON.stringify(marked));
      await backend.commit(session, await backend.listParts(session), 'application/octet-stream');
      return { backend, key: session.key };
    }

    // 60 s: an emulator serving several test files at once can take longer than
    // the 10 s default to create or delete a bucket / container.
    beforeAll(async () => {
      clearEnv();
      await createBucket(kind, bucket);
    }, 60_000);
    afterAll(async () => {
      await deleteBucket(kind, bucket);
    }, 60_000);

    it('stores a multi-part file byte-for-byte, with the composite checksum and type', async () => {
      let readBack: Uint8Array | undefined;
      const up = uploader({ onComplete: async ({ file }) => void (readBack = await readAll(file.read())) });
      const bytes = fileOf(SIZE, 11, PNG);
      const begun = await up.begin(ALICE, { fileName: 'photo.png', totalBytes: SIZE, fingerprint: 'fp-full', contentType: 'image/png' });
      await sendParts(up, ALICE, begun.session.manifest.uploadId, bytes, 'fp-full', partsOf(SIZE));
      const done = await up.complete(ALICE, begun.session.manifest.uploadId);

      expect(sha256(readBack as Uint8Array)).toBe(sha256(bytes)); // the stored object, read back from the provider
      expect(done).toMatchObject({
        size: SIZE,
        sha256: '',
        contentType: 'image/png',
        deduplicated: false,
        checksum: { type: 'sha256-composite', value: expectedComposite(bytes, CLOUD_PART_BYTES), parts: 3 },
      });
      // <namespace hash>/<upload id>-<session id>: unique per session, fixed at begin.
      expect(done.key).toMatch(new RegExp(`^files/[0-9a-f]{32}/${begun.session.manifest.uploadId}-[0-9a-f]{16}\\.png$`));
      expect(done.key).toBe(begun.session.manifest.cloud?.key);
      // Nothing left behind: no control files, no open multipart session.
      expect(await up.list(ALICE)).toEqual([]);
      if (kind !== 'azure_blob') expect(await openS3MultipartUploads(bucket)).toBe(0);
    });

    it('resumes from the provider\'s own part list, sending only what is missing', async () => {
      const up = uploader();
      const bytes = fileOf(SIZE, 12);
      const input = { fileName: 'video.bin', totalBytes: SIZE, fingerprint: 'fp-resume' };
      const first = await up.begin(ALICE, input);
      const id = first.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-resume', [1, 3]);

      const again = await up.begin(ALICE, input);
      expect(again.created).toBe(false);
      expect(again.session.missingParts).toEqual([2]);
      expect(again.session.receivedBytes).toBe(CLOUD_PART_BYTES + 777);
      expect(await code(up.complete(ALICE, id))).toBe('INCOMPLETE');

      await sendParts(up, ALICE, id, bytes, 'fp-resume', [2]);
      expect((await up.complete(ALICE, id)).checksum?.value).toBe(expectedComposite(bytes, CLOUD_PART_BYTES));
    });

    it('accepts parts out of order, concurrently, and a repeated part, with the same result', async () => {
      const up = uploader();
      const bytes = fileOf(SIZE, 13);
      const begun = await up.begin(ALICE, { fileName: 'concurrent.bin', totalBytes: SIZE, fingerprint: 'fp-conc' });
      const id = begun.session.manifest.uploadId;
      await Promise.all(
        [3, 2, 1, 2].map((index) => up.putPart(ALICE, { uploadId: id, index, bytes: partOf(bytes, index, CLOUD_PART_BYTES), fingerprint: 'fp-conc' })),
      );
      expect((await up.complete(ALICE, id)).checksum?.value).toBe(expectedComposite(bytes, CLOUD_PART_BYTES));
    });

    it('refuses a wrong-length part and a checksum mismatch, storing neither', async () => {
      const up = uploader();
      const bytes = fileOf(SIZE, 14);
      const begun = await up.begin(ALICE, { fileName: 'refuse.bin', totalBytes: SIZE, fingerprint: 'fp-ref' });
      const id = begun.session.manifest.uploadId;
      const part2 = partOf(bytes, 2, CLOUD_PART_BYTES);
      expect(await code(up.putPart(ALICE, { uploadId: id, index: 2, bytes: part2.subarray(1), fingerprint: 'fp-ref' }))).toBe('PART_LENGTH_MISMATCH');
      expect(await code(up.putPart(ALICE, { uploadId: id, index: 2, bytes: part2, fingerprint: 'fp-ref', sha256: sha256(partOf(bytes, 1, CLOUD_PART_BYTES)) }))).toBe('PART_CHECKSUM_MISMATCH');
      expect(await code(up.putPart(ALICE, { uploadId: id, index: 2, bytes: part2, fingerprint: 'other' }))).toBe('FINGERPRINT_MISMATCH');
      expect((await up.status(ALICE, id)).receivedBytes).toBe(0);
      await up.discard(ALICE, id);
    });

    it('isolates users: the same file from two users is two uploads, and one discard leaves the other', async () => {
      const up = uploader();
      const bytes = fileOf(SIZE, 15);
      const same = { fileName: 'shared.bin', totalBytes: SIZE, fingerprint: 'fp-shared' };
      const a = await up.begin(ALICE, same);
      const b = await up.begin(BOB, same);
      expect(a.session.manifest.uploadId).toBe(b.session.manifest.uploadId); // same identity, separate namespaces
      const id = a.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-shared', [1]);
      await sendParts(up, BOB, id, bytes, 'fp-shared', [1, 2]);
      await up.discard(BOB, id);
      expect(await code(up.status(BOB, id))).toBe('NO_SESSION');
      expect((await up.status(ALICE, id)).receivedBytes).toBe(CLOUD_PART_BYTES);
      await up.discard(ALICE, id);
    });

    it('refuses an executable renamed to .png BEFORE commit, keeping the parts', async () => {
      const up = uploader({ allowedTypes: ['image/*'] });
      const bytes = fileOf(SIZE, 16, EXE);
      const begun = await up.begin(ALICE, { fileName: 'holiday.png', totalBytes: SIZE, fingerprint: 'fp-exe', contentType: 'image/png' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-exe', partsOf(SIZE));
      const err = await up.complete(ALICE, id).catch((e: unknown) => e);
      expect((err as UploadError).code).toBe('FILE_TYPE_NOT_ALLOWED');
      expect((err as UploadError).message).toContain('its content is a Windows executable, not image/png');
      // Never committed: the parts are still in the provider's session.
      expect((await up.status(ALICE, id)).complete).toBe(true);
      const backend = await backendFor(base());
      expect(await backend.readObjectHead(begun.session.manifest.cloud?.key as string, 16).catch(() => 'absent')).not.toEqual(bytes.subarray(0, 16));
      await up.discard(ALICE, id);
    });

    it('does not trust a kept head that no longer matches the provider\'s part 1', async () => {
      // Two concurrent sends of part 1 with different bytes can leave the
      // provider with one version and the kept head with the other. The head is
      // bound to its part's SHA-256, so a mismatch falls back to checking the
      // committed bytes — and the executable is refused and deleted.
      // MUTATION: skip the SHA-256 comparison in trustedHead -> the PNG head is
      // trusted and the executable is stored.
      const up = uploader({ allowedTypes: ['image/*'] });
      const png = fileOf(SIZE, 17, PNG);
      const exe = fileOf(SIZE, 17, EXE);
      const begun = await up.begin(ALICE, { fileName: 'race.png', totalBytes: SIZE, fingerprint: 'fp-race', contentType: 'image/png' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, png, 'fp-race', partsOf(SIZE)); // head kept: the PNG's
      const backend = await backendFor(base());
      const exePart1 = partOf(exe, 1, CLOUD_PART_BYTES);
      await backend.putPart(begun.session.manifest.cloud as never, 1, exePart1, sha256(exePart1)); // the "other" concurrent send wins
      const err = await up.complete(ALICE, id).catch((e: unknown) => e);
      expect((err as UploadError).code).toBe('FILE_TYPE_NOT_ALLOWED');
      expect(await backend.readObjectHead(begun.session.manifest.cloud?.key as string, 16).then((h) => h.byteLength).catch(() => 0)).toBe(0);
    });

    it('retries a failed onComplete without re-uploading, and stores the file once', async () => {
      let calls = 0;
      const up = uploader({
        onComplete: () => {
          calls += 1;
          if (calls === 1) throw new Error('database down');
          return { saved: true };
        },
      });
      const bytes = fileOf(SIZE, 18);
      const begun = await up.begin(ALICE, { fileName: 'retry.bin', totalBytes: SIZE, fingerprint: 'fp-retry' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-retry', partsOf(SIZE));
      await expect(up.complete(ALICE, id)).rejects.toThrow('database down');
      const retried = await up.complete(ALICE, id);
      expect(retried).toMatchObject({ result: { saved: true }, size: SIZE });
      expect(calls).toBe(2);
      const backend = await backendFor(base());
      expect(sha256(await readAll(backend.openRead(retried.key)))).toBe(sha256(bytes));
    });

    it('a reload after the commit resumes with nothing to send, and complete finishes the file', async () => {
      // The provider consumed the parts at commit, so none can be sent again (S3
      // refuses parts of a completed upload, and a committed manifest refuses
      // them here). A reload that reported them missing would strand the file.
      // MUTATION: drop both "every part" branches of listVerifiedCloudParts ->
      // the resumed begin reports every part missing. (Either branch alone
      // covers this case: a committed file also carries the commit marker.)
      let calls = 0;
      const up = uploader({
        onComplete: () => {
          calls += 1;
          if (calls === 1) throw new Error('database down');
          return { saved: true };
        },
      });
      const bytes = fileOf(SIZE, 27);
      const input = { fileName: 'reload.bin', totalBytes: SIZE, fingerprint: 'fp-reload' };
      const begun = await up.begin(ALICE, input);
      await sendParts(up, ALICE, begun.session.manifest.uploadId, bytes, 'fp-reload', partsOf(SIZE));
      await expect(up.complete(ALICE, begun.session.manifest.uploadId)).rejects.toThrow('database down');

      const reloaded = await up.begin(ALICE, input); // the page reloads and the file is picked again
      expect(reloaded.created).toBe(false);
      expect(reloaded.session.missingParts).toEqual([]);
      expect(reloaded.session.receivedBytes).toBe(SIZE);
      const done = await up.complete(ALICE, begun.session.manifest.uploadId);
      expect(done).toMatchObject({ result: { saved: true }, size: SIZE });
      const backend = await backendFor(base());
      expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
    });

    it('a cleanup that fails after onComplete never lets a later discard delete the recorded file', async () => {
      // While the manifest exists, discard reads `committed` and deletes the
      // file. complete therefore removes the manifest FIRST; the rest of the
      // session directory failing to go must leave the app's file alone.
      // MUTATION: remove the manifest only through removeTree (as before) ->
      // the failed cleanup leaves it, and the discard deletes the stored file.
      const up = uploader({ onComplete: () => ({ saved: true }) });
      const bytes = fileOf(SIZE, 28);
      const begun = await up.begin(ALICE, { fileName: 'kept.bin', totalBytes: SIZE, fingerprint: 'fp-cleanup' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-cleanup', partsOf(SIZE));

      const backend = await backendFor(base()); // the uploader's own (cached) backend
      const control = backend.control;
      const realRemoveTree = control.removeTree.bind(control);
      Object.assign(control, { removeTree: async () => Promise.reject(new Error('storage unavailable')) });
      let done: Awaited<ReturnType<Uploader['complete']>>;
      try {
        done = await up.complete(ALICE, id);
      } finally {
        Object.assign(control, { removeTree: realRemoveTree });
      }
      expect(done).toMatchObject({ result: { saved: true }, size: SIZE });

      await up.discard(ALICE, id); // e.g. the user clicks cancel on a stale tab
      expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
      await backend.deleteObject(done.key);
    });

    it('finishes an upload whose commit happened but was never recorded (a crash mid-complete)', async () => {
      // The provider consumes the parts on commit. If the server stops before
      // recording it, a retry finds no parts — and without recovery would
      // report INCOMPLETE forever for a file that is stored.
      // MUTATION: make interruptedCommit return null -> this complete fails INCOMPLETE.
      let recorded: { key: string; size: number } | undefined;
      const up = uploader({ onComplete: ({ file }) => void (recorded = { key: file.key, size: file.size }) });
      const bytes = fileOf(SIZE, 22);
      const begun = await up.begin(ALICE, { fileName: 'crash.bin', totalBytes: SIZE, fingerprint: 'fp-crash' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-crash', partsOf(SIZE));
      const { backend } = await commitThenCrash(begun.session.manifest);

      // A reload after the crash: nothing left to send, straight to complete.
      // MUTATION: drop the commit-marker branch of listVerifiedCloudParts -> every part reported missing.
      const reloaded = await up.begin(ALICE, { fileName: 'crash.bin', totalBytes: SIZE, fingerprint: 'fp-crash' });
      expect(reloaded.session.missingParts).toEqual([]);

      const done = await up.complete(ALICE, id);
      expect(done).toMatchObject({ size: SIZE, checksum: null }); // the composite is not recoverable after the fact
      expect(recorded).toEqual({ key: done.key, size: SIZE });
      expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
      expect(await code(up.status(ALICE, id))).toBe('NO_SESSION');
    });

    it('discarding a crashed commit removes the file it left behind', async () => {
      // MUTATION: drop the orphan delete in releaseCloudSession -> the object survives (every kind).
      const up = uploader();
      const bytes = fileOf(SIZE, 23);
      const begun = await up.begin(ALICE, { fileName: 'crash-discard.bin', totalBytes: SIZE, fingerprint: 'fp-crash-discard' });
      await sendParts(up, ALICE, begun.session.manifest.uploadId, bytes, 'fp-crash-discard', partsOf(SIZE));
      const { backend, key } = await commitThenCrash(begun.session.manifest);
      expect((await backend.control.stat(key))?.size).toBe(SIZE);

      await up.discard(ALICE, begun.session.manifest.uploadId);
      expect(await backend.control.stat(key)).toBeNull();
      expect(await code(up.status(ALICE, begun.session.manifest.uploadId))).toBe('NO_SESSION');
    });

    it('a re-upload of an already stored file gets its own key; refusing or discarding it keeps the earlier copy', async () => {
      // The same file gets the same upload id. If it also got the same storage
      // key, a re-upload would commit over — and, refused after the commit
      // (direct transfer), delete — the earlier copy. With proxy transfer the
      // refusal comes before any commit, so here the key itself is the evidence.
      // MUTATION: drop "-<sessionId>" from the default key -> `not.toBe(stored.key)` fails.
      const refuseSecond = { validateHead: (_head: Uint8Array, info: { metadata: unknown }) => {
        if ((info.metadata as { attempt?: number } | null)?.attempt === 2) throw new Error('second attempt refused');
      } };
      const up = uploader(refuseSecond);
      const bytes = fileOf(SIZE, 24);
      const first = await up.begin(ALICE, { fileName: 'again.bin', totalBytes: SIZE, fingerprint: 'fp-again', metadata: { attempt: 1 } });
      await sendParts(up, ALICE, first.session.manifest.uploadId, bytes, 'fp-again', partsOf(SIZE));
      const stored = await up.complete(ALICE, first.session.manifest.uploadId);

      // Resume keeps the key — only a NEW session mints one.
      const again = await up.begin(ALICE, { fileName: 'again.bin', totalBytes: SIZE, fingerprint: 'fp-again', metadata: { attempt: 2 } });
      const resumed = await up.begin(ALICE, { fileName: 'again.bin', totalBytes: SIZE, fingerprint: 'fp-again', metadata: { attempt: 2 } });
      expect(again.session.manifest.uploadId).toBe(first.session.manifest.uploadId);
      expect(again.session.manifest.cloud?.key).not.toBe(stored.key);
      expect(resumed.session.manifest.cloud?.key).toBe(again.session.manifest.cloud?.key);
      expect(await code(up.complete(ALICE, again.session.manifest.uploadId))).toBe('INCOMPLETE');

      await sendParts(up, ALICE, again.session.manifest.uploadId, bytes, 'fp-again', partsOf(SIZE));
      expect(await code(up.complete(ALICE, again.session.manifest.uploadId))).toBe('REJECTED');
      await up.discard(ALICE, again.session.manifest.uploadId);

      const backend = await backendFor(base());
      expect(sha256(await readAll(backend.openRead(stored.key)))).toBe(sha256(bytes));
      expect(await backend.control.stat(again.session.manifest.cloud?.key as string)).toBeNull();
    });

    it('discard releases the provider session: no parts, no control files, nothing open', async () => {
      const up = uploader();
      const bytes = fileOf(SIZE, 19);
      const begun = await up.begin(ALICE, { fileName: 'discard.bin', totalBytes: SIZE, fingerprint: 'fp-disc' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-disc', [1, 2]);
      await up.discard(ALICE, id);
      expect(await code(up.status(ALICE, id))).toBe('NO_SESSION');
      await expectProviderReleased(begun.session.manifest.cloud);
      if (kind !== 'azure_blob') expect(await openS3MultipartUploads(bucket)).toBe(0);
      // The discarded parts are gone for good: the same file begun again starts
      // from nothing (on Azure, the left-over blocks carry the old session's tag).
      const again = await up.begin(ALICE, { fileName: 'discard.bin', totalBytes: SIZE, fingerprint: 'fp-disc' });
      expect(again.created).toBe(true);
      expect(again.session.missingParts).toEqual(partsOf(SIZE));
      await up.discard(ALICE, again.session.manifest.uploadId);
    });

    it('two concurrent begins of one file produce one upload and leak no provider session', async () => {
      const up = uploader();
      const input = { fileName: 'race-begin.bin', totalBytes: SIZE, fingerprint: 'fp-rb' };
      const [x, y] = await Promise.all([up.begin(ALICE, input), up.begin(ALICE, input)]);
      expect(x.session.manifest.uploadId).toBe(y.session.manifest.uploadId);
      expect([x.created, y.created].sort()).toEqual([false, true]);
      if (kind !== 'azure_blob') expect(await openS3MultipartUploads(bucket)).toBe(1);
      await up.discard(ALICE, x.session.manifest.uploadId);
      if (kind !== 'azure_blob') expect(await openS3MultipartUploads(bucket)).toBe(0);
    });

    it('the sweep removes an abandoned upload and its provider session, and keeps a fresh one', async () => {
      // Object timestamps have 1-second resolution, so a file written now can
      // look up to a second old. A 4 s TTL leaves the fresh upload 3 s of slack
      // for a loaded emulator (a 1.5 s TTL left 0.5 s, and a loaded run swept
      // the fresh upload too); the old one is waited well past TTL + 1 s.
      const up = uploader({ partTtlMs: 4000 });
      const bytes = fileOf(SIZE, 20);
      const old = await up.begin(ALICE, { fileName: 'old.bin', totalBytes: SIZE, fingerprint: 'fp-old' });
      await sendParts(up, ALICE, old.session.manifest.uploadId, bytes, 'fp-old', [1]);
      await wait(5500);
      const fresh = await up.begin(ALICE, { fileName: 'fresh.bin', totalBytes: SIZE, fingerprint: 'fp-fresh' });
      const result = await up.sweep();
      expect(result.deleted).toBe(1);
      expect((await up.list(ALICE)).map((s) => s.manifest.fileName)).toEqual(['fresh.bin']);
      await expectProviderReleased(old.session.manifest.cloud);
      await up.discard(ALICE, fresh.session.manifest.uploadId);
    });

    it('stores a 40 MiB file in 8 parts byte-for-byte', async () => {
      const size = 40 * MIB + 3;
      const bytes = fileOf(size, 21);
      const up = uploader();
      const begun = await up.begin(ALICE, { fileName: 'large.bin', totalBytes: size, fingerprint: 'fp-large' });
      const id = begun.session.manifest.uploadId;
      await sendParts(up, ALICE, id, bytes, 'fp-large', partsOf(size));
      const done = await up.complete(ALICE, id);
      const backend = await backendFor(base());
      expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
      expect(done.checksum).toMatchObject({ type: 'sha256-composite', parts: 9, value: expectedComposite(bytes, CLOUD_PART_BYTES) });
    }, 120_000);
  });
});
