// ---------------------------------------------------------------------------
// direct-scenarios.test.ts — browser → storage with signed URLs, per backend
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. Direct transfer hands the browser a URL that bypasses the
// server, so the STORAGE must enforce what the server would have: the signed
// SHA-256 (S3) / MD5 (Azure), the exact length, expiry and write-only scope.
// Each refusal is provoked with a real PUT to the emulator and asserted, and the
// server's own checks (size at commit, content check after commit with the
// refused file deleted) are asserted too. Ends with the real browser client
// uploading and resuming through direct transfer.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchPartSender } from '../../src/client/transport.js';
import { startUpload } from '../../src/client/upload.js';
import { UploadError } from '../../src/core/errors.js';
import { manifestKey } from '../../src/core/layout.js';
import type { UploadManifest } from '../../src/core/session.js';
import { namespaceKeyFor } from '../../src/server/namespace.js';
import { createUploadRoutes } from '../../src/server/routes.js';
import { createUploader, type Uploader, type UploaderOptions } from '../../src/server/uploader.js';
import { azureBlockId } from '../../src/storage/cloud/checksums.js';
import { clearEnv, partOf, patternBytes } from '../helpers.js';
import {
  AVAILABLE,
  CLOUD_PART_BYTES,
  azureBlob,
  backendFor,
  barrier,
  createBucket,
  deleteBucket,
  expectedComposite,
  readAll,
  sha256,
  storageOptions,
  uniqueBucketName,
  wait,
  type CloudKind,
} from './cloud-helpers.js';

const ALICE = { namespace: 'user-alice' };
const SIZE = 2 * CLOUD_PART_BYTES + 321;
const EXE = [0x4d, 0x5a, 0x90, 0x00];

const md5b64 = (b: Uint8Array) => createHash('md5').update(b).digest('base64');

function fileOf(size: number, seed: number, signature?: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = patternBytes(size, seed);
  if (signature) bytes.set(signature);
  return bytes;
}

/** The UploadError code a promise rejects with, or 'resolved'. */
function errorCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'resolved',
    (err: unknown) => (err instanceof UploadError ? err.code : `unexpected: ${String(err)}`),
  );
}

/**
 * The HTTP status, or 'reset' when the storage refused by closing the
 * connection before reading the body (VersityGW does so for an expired
 * signature; a browser sees a network error, which the client retries with a
 * fresh URL). Both are refusals; the tests then assert nothing was stored.
 */
async function put(url: string, headers: Record<string, string>, body: Uint8Array<ArrayBuffer>): Promise<number | 'reset'> {
  try {
    const res = await fetch(url, { method: 'PUT', headers, body });
    await res.arrayBuffer();
    return res.status;
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === 'ECONNRESET') return 'reset';
    throw err;
  }
}

describe.skipIf(AVAILABLE.length === 0)('cloud backends — direct transfer', () => {
  describe.each(AVAILABLE)('%s', (kind: CloudKind) => {
    const bucket = uniqueBucketName(`direct-${kind.replace('_', '')}`);
    const base = (extra: UploaderOptions = {}): UploaderOptions => ({
      ...storageOptions(kind, bucket, { transfer: 'direct' }),
      partBytes: CLOUD_PART_BYTES,
      sweepOnBegin: false,
      ...extra,
    });
    const uploader = (extra: UploaderOptions = {}): Uploader => createUploader(base(extra));
    const needsMd5 = kind === 'azure_blob';

    /** Presign and PUT one part straight to the storage, as a browser would. */
    async function sendDirect(up: Uploader, id: string, fp: string, bytes: Uint8Array<ArrayBuffer>, index: number, body = partOf(bytes, index, CLOUD_PART_BYTES)) {
      const part = partOf(bytes, index, CLOUD_PART_BYTES);
      const signed = await up.presignPart(ALICE, { uploadId: id, index, fingerprint: fp, sha256: sha256(part), ...(needsMd5 ? { md5: md5b64(part) } : {}) });
      return put(signed.url, signed.headers as Record<string, string>, body);
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

    it('a part URL cannot replace the stored file after its content was checked', async () => {
      // An Azure write SAS covers the WHOLE blob it names: with comp=block and
      // blockid stripped it is a Put Blob, replacing the blob. Part URLs must
      // therefore never name the final key (Azure: they name a staging blob).
      // On S3 the stripped URL no longer matches its signature.
      // MUTATION (the pre-fix design): no staging blob — openCloudSession passes
      // no stagingKey and presignPart signs session.key -> the stored file
      // becomes the attacker's bytes (verified: the hash assertion fails).
      const up = uploader();
      const bytes = fileOf(SIZE, 37);
      const begun = await up.begin(ALICE, { fileName: 'kept.bin', totalBytes: SIZE, fingerprint: 'fp-kept' });
      const id = begun.session.manifest.uploadId;
      const part1 = partOf(bytes, 1, CLOUD_PART_BYTES);
      const kept = await up.presignPart(ALICE, { uploadId: id, index: 1, fingerprint: 'fp-kept', sha256: sha256(part1), ...(needsMd5 ? { md5: md5b64(part1) } : {}) });
      for (const index of [1, 2, 3]) expect([200, 201]).toContain(await sendDirect(up, id, 'fp-kept', bytes, index));
      const done = await up.complete(ALICE, id);

      const wholeObject = kept.url.replace(/([?&])(comp=block&blockid=[^&]*|partNumber=[^&]*|uploadId=[^&]*)&?/g, '$1');
      const evil = new TextEncoder().encode('MZ-not-the-checked-file') as Uint8Array<ArrayBuffer>;
      await put(wholeObject, { 'x-ms-version': '2025-01-05', 'x-ms-blob-type': 'BlockBlob' }, evil);

      const backend = await backendFor(base());
      expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
    });

    it.runIf(kind === 'azure_blob')('a staged commit that stopped part-way is finished by a retry, or removed by a discard', async () => {
      // Azure direct commits in three steps: commit the staging blob, copy it to
      // the final key, delete the staging blob. A server can stop after the first
      // (staging committed, final key empty) or the second (an unrecorded copy).
      // MUTATIONS (each checked on its own):
      //   listParts reading only 'uncommitted' for a staged session -> the retry
      //     before the copy reports INCOMPLETE;
      //   releaseCloudSession using ownCommittedObject for a staged session ->
      //     the discard after the copy leaves it stored;
      //   the DESTINATION_EXISTS check ignoring the marker -> the retry after
      //     the copy is refused.
      const endings = [
        { stopped: 'before-copy', then: 'retry' },
        { stopped: 'after-copy', then: 'retry' },
        { stopped: 'after-copy', then: 'discard' },
      ] as const;
      for (const [n, { stopped, then }] of endings.entries()) {
        const ending = `${stopped}-${then}`;
        const up = uploader();
        const bytes = fileOf(SIZE, 39 + n);
        const fp = `fp-staged-${ending}`;
        const begun = await up.begin(ALICE, { fileName: `staged-${ending}.bin`, totalBytes: SIZE, fingerprint: fp });
        const id = begun.session.manifest.uploadId;
        for (const index of [1, 2, 3]) expect([200, 201]).toContain(await sendDirect(up, id, fp, bytes, index));
        const session = begun.session.manifest.cloud as NonNullable<UploadManifest['cloud']>;
        expect(session.stagingKey).toBeDefined();

        // What the stopped complete had done: marker, staging commit, copy.
        const backend = await backendFor(base());
        const marked = { ...begun.session.manifest, commitStartedAt: new Date().toISOString() };
        await backend.control.write?.(manifestKey(namespaceKeyFor(ALICE.namespace), id), JSON.stringify(marked));
        const staging = await azureBlob(bucket, session.stagingKey as string);
        await staging.commitBlockList((await backend.listParts(session)).map((p) => azureBlockId(p.index, p.sha256 as string, session.blockTag)));
        if (stopped === 'after-copy') {
          // A real server-side copy, as the stopped complete made it: the final
          // blob records the staging blob as its copy source, which is how a
          // retry recognises the copy as its own.
          const { BlobSASPermissions } = await import('@azure/storage-blob');
          const source = await staging.generateSasUrl({ permissions: BlobSASPermissions.parse('r'), expiresOn: new Date(Date.now() + 600_000) });
          await (await (await azureBlob(bucket, session.key)).beginCopyFromURL(source)).pollUntilDone();
        }

        if (then === 'retry') {
          const done = await up.complete(ALICE, id);
          expect(done.key).toBe(session.key);
          expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
        } else {
          await up.discard(ALICE, id);
          expect(await backend.control.stat(session.key)).toBeNull();
        }
        expect(await staging.exists()).toBe(false);
        expect(await errorCode(up.status(ALICE, id))).toBe('NO_SESSION');
      }
    });

    it('two direct uploads committing onto one shared key at the same moment: exactly one stores', async () => {
      // Direct transfer's commit is S3's conditional CompleteMultipartUpload, or
      // Azure's conditional copy from each session's staging blob.
      // MUTATIONS: drop IfNoneMatch (S3) or the copy's ifNoneMatch condition
      // (Azure) -> both "succeed", the second replacing the first.
      const up = uploader({ destination: ({ extension }) => `shared/direct-race.${extension}` });
      const ALICE_TWO = { namespace: 'user-alice-two' };
      const first = fileOf(SIZE, 41);
      const second = fileOf(SIZE, 42);
      const a = await up.begin(ALICE, { fileName: 'r.bin', totalBytes: SIZE, fingerprint: 'fp-dr-a' });
      const b = await up.begin(ALICE_TWO, { fileName: 'r.bin', totalBytes: SIZE, fingerprint: 'fp-dr-b' });
      for (const index of [1, 2, 3]) {
        expect([200, 201]).toContain(await sendDirect(up, a.session.manifest.uploadId, 'fp-dr-a', first, index));
        const part = partOf(second, index, CLOUD_PART_BYTES);
        const signed = await up.presignPart(ALICE_TWO, {
          uploadId: b.session.manifest.uploadId,
          index,
          fingerprint: 'fp-dr-b',
          sha256: sha256(part),
          ...(needsMd5 ? { md5: md5b64(part) } : {}),
        });
        expect([200, 201]).toContain(await put(signed.url, signed.headers as Record<string, string>, part));
      }
      const backend = await backendFor(base());
      const realCommit = backend.commit;
      const meet = barrier(2);
      Object.assign(backend, {
        commit: async (...args: Parameters<typeof realCommit>) => {
          await meet.arrive();
          return realCommit(...args);
        },
      });
      let outcomes: string[];
      try {
        outcomes = await Promise.all([
          errorCode(up.complete(ALICE, a.session.manifest.uploadId)),
          errorCode(up.complete(ALICE_TWO, b.session.manifest.uploadId)),
        ]);
      } finally {
        Object.assign(backend, { commit: realCommit });
      }
      expect([...outcomes].sort()).toEqual(['DESTINATION_EXISTS', 'resolved']);
      const winner = outcomes[0] === 'resolved' ? first : second;
      expect(sha256(await readAll(backend.openRead('shared/direct-race.bin')))).toBe(sha256(winner));
      const [loserCtx, loserId] = outcomes[0] === 'resolved' ? [ALICE_TWO, b.session.manifest.uploadId] : [ALICE, a.session.manifest.uploadId];
      await up.discard(loserCtx, loserId);
      expect(sha256(await readAll(backend.openRead('shared/direct-race.bin')))).toBe(sha256(winner));
      await backend.deleteObject('shared/direct-race.bin');
    });

    it('uploads every part straight to the storage and commits it byte-for-byte', async () => {
      const up = uploader();
      const bytes = fileOf(SIZE, 31);
      const begun = await up.begin(ALICE, { fileName: 'direct.bin', totalBytes: SIZE, fingerprint: 'fp-d' });
      const id = begun.session.manifest.uploadId;
      for (const index of [1, 2, 3]) expect([200, 201]).toContain(await sendDirect(up, id, 'fp-d', bytes, index));
      const done = await up.complete(ALICE, id);
      const backend = await backendFor(base());
      expect(sha256(await readAll(backend.openRead(done.key)))).toBe(sha256(bytes));
      // S3 verified every part's signed SHA-256, so its composite is reported.
      // Azure verifies only MD5, and the block ids are the browser's — no composite is claimed.
      if (kind === 'azure_blob') expect(done.checksum).toBeNull();
      else expect(done.checksum).toMatchObject({ type: 'sha256-composite', value: expectedComposite(bytes, CLOUD_PART_BYTES) });
    });

    it('the storage refuses other bytes sent with a valid URL, and the part is not counted', async () => {
      // MUTATION (s3-backend): hoist x-amz-checksum-sha256 out of the signed headers → S3 stores the other bytes.
      const up = uploader();
      const bytes = fileOf(SIZE, 32);
      const begun = await up.begin(ALICE, { fileName: 'tamper.bin', totalBytes: SIZE, fingerprint: 'fp-t' });
      const id = begun.session.manifest.uploadId;
      const other = fileOf(CLOUD_PART_BYTES, 99);
      expect(await sendDirect(up, id, 'fp-t', bytes, 1, other)).toBe(400); // BadDigest / Md5Mismatch
      expect((await up.status(ALICE, id)).missingParts).toContain(1);
      await up.discard(ALICE, id);
    });

    it('a part of the wrong length never completes the upload', async () => {
      const up = uploader();
      const bytes = fileOf(SIZE, 33);
      const begun = await up.begin(ALICE, { fileName: 'length.bin', totalBytes: SIZE, fingerprint: 'fp-l' });
      const id = begun.session.manifest.uploadId;
      const short = partOf(bytes, 1, CLOUD_PART_BYTES).subarray(0, 1024);
      const part = partOf(bytes, 1, CLOUD_PART_BYTES);
      const signed = await up.presignPart(ALICE, { uploadId: id, index: 1, fingerprint: 'fp-l', sha256: sha256(part), ...(needsMd5 ? { md5: md5b64(short) } : {}) });
      const status = await put(signed.url, { ...(signed.headers as Record<string, string>), ...(needsMd5 ? { 'Content-MD5': md5b64(short) } : {}) }, short);
      if (kind === 'azure_blob') {
        // Azure SAS cannot bind a length: the short block is accepted by Azure,
        // but the server counts only parts of the exact size.
        expect(status).toBe(201);
      } else {
        expect(status).toBe(403); // content-length is signed: SignatureDoesNotMatch
      }
      expect((await up.status(ALICE, id)).missingParts).toContain(1);
      for (const index of [2, 3]) await sendDirect(up, id, 'fp-l', bytes, index);
      expect(await errorCode(up.complete(ALICE, id))).toBe('INCOMPLETE');
      await up.discard(ALICE, id);
    });

    it('an expired URL is refused by the storage', async () => {
      const up = uploader({ directUrlTtlSeconds: 1 });
      const bytes = fileOf(SIZE, 34);
      const begun = await up.begin(ALICE, { fileName: 'expired.bin', totalBytes: SIZE, fingerprint: 'fp-e' });
      const id = begun.session.manifest.uploadId;
      const part = partOf(bytes, 1, CLOUD_PART_BYTES);
      const signed = await up.presignPart(ALICE, { uploadId: id, index: 1, fingerprint: 'fp-e', sha256: sha256(part), ...(needsMd5 ? { md5: md5b64(part) } : {}) });
      await wait(2500);
      expect([403, 'reset']).toContain(await put(signed.url, signed.headers as Record<string, string>, part));
      expect((await up.status(ALICE, id)).missingParts).toContain(1); // refused: nothing stored
      await up.discard(ALICE, id);
    });

    it('refuses to sign when direct transfer is off, and validates the checksums asked for', async () => {
      const proxyOnly = createUploader({ ...storageOptions(kind, bucket), partBytes: CLOUD_PART_BYTES, sweepOnBegin: false });
      const begun = await proxyOnly.begin(ALICE, { fileName: 'proxy-only.bin', totalBytes: SIZE, fingerprint: 'fp-p' });
      const id = begun.session.manifest.uploadId;
      const err = await proxyOnly.presignPart(ALICE, { uploadId: id, index: 1, fingerprint: 'fp-p', sha256: 'a'.repeat(64) }).catch((e: UploadError) => e);
      expect(err).toMatchObject({ code: 'INVALID_REQUEST', message: 'Direct transfer is not enabled on this server; send parts through it.' });

      const up = uploader();
      expect(await errorCode(up.presignPart(ALICE, { uploadId: id, index: 1, fingerprint: 'fp-p', sha256: 'not-hex' }))).toBe('INVALID_REQUEST');
      expect(
        await errorCode(up.presignPart(ALICE, { uploadId: id, index: 9, fingerprint: 'fp-p', sha256: 'a'.repeat(64), md5: md5b64(new Uint8Array(1)) })),
      ).toBe('PART_OUT_OF_RANGE');
      if (needsMd5) {
        expect(await errorCode(up.presignPart(ALICE, { uploadId: id, index: 1, fingerprint: 'fp-p', sha256: 'a'.repeat(64) }))).toBe('INVALID_REQUEST');
      }
      await up.discard(ALICE, id);
    });

    it('checks the committed content when the server never saw it, and deletes a refused file', async () => {
      const up = uploader({ allowedTypes: ['image/*'] });
      const bytes = fileOf(SIZE, 35, EXE);
      const begun = await up.begin(ALICE, { fileName: 'holiday.png', totalBytes: SIZE, fingerprint: 'fp-x', contentType: 'image/png' });
      const id = begun.session.manifest.uploadId;
      for (const index of [1, 2, 3]) await sendDirect(up, id, 'fp-x', bytes, index);
      const err = await up.complete(ALICE, id).catch((e: UploadError) => e);
      expect(err).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
      const backend = await backendFor(base());
      expect((await backend.readObjectHead(begun.session.manifest.cloud?.key as string, 16).catch(() => new Uint8Array(0))).byteLength).toBe(0);
      // This upload's session is gone too (asserted by id, independent of other tests).
      expect(await errorCode(up.status(ALICE, id))).toBe('NO_SESSION');
    });

    it('keeps the session when deleting a refused file fails, so the file is still found and removed', async () => {
      // The manifest is the only record of a committed-but-refused file. Dropping
      // it after a failed delete left the file stored where nothing would ever
      // find it again — not a retry, not discard, not the sweep.
      // MUTATION: make deleteRefusedFile remove the session even when the delete
      // failed -> status is NO_SESSION and the refused file stays stored.
      const up = uploader({ allowedTypes: ['image/*'] });
      const bytes = fileOf(SIZE, 38, EXE);
      const begun = await up.begin(ALICE, { fileName: 'stuck.png', totalBytes: SIZE, fingerprint: 'fp-stuck', contentType: 'image/png' });
      const id = begun.session.manifest.uploadId;
      const key = begun.session.manifest.cloud?.key as string;
      for (const index of [1, 2, 3]) await sendDirect(up, id, 'fp-stuck', bytes, index);

      const backend = await backendFor(base()); // the uploader's own (cached) backend
      const realDelete = backend.deleteObject;
      let failedDeletes = 0;
      Object.assign(backend, {
        deleteObject: async () => {
          failedDeletes += 1;
          throw new Error('storage unavailable');
        },
      });
      try {
        expect(await errorCode(up.complete(ALICE, id))).toBe('FILE_TYPE_NOT_ALLOWED');
        expect(failedDeletes).toBe(1);
      } finally {
        Object.assign(backend, { deleteObject: realDelete });
      }
      expect((await backend.control.stat(key))?.size).toBe(SIZE); // still stored…
      expect((await up.status(ALICE, id)).manifest.commitStartedAt).toBeTruthy(); // …and still recorded

      await up.discard(ALICE, id);
      expect(await backend.control.stat(key)).toBeNull();
      expect(await errorCode(up.status(ALICE, id))).toBe('NO_SESSION');
    });

    it('the browser client uploads, pauses and resumes through direct transfer', async () => {
      const routes = createUploadRoutes({ ...base(), authorize: () => ALICE });
      const dispatch: typeof fetch = async (input, init) => {
        const request = new Request(new URL(String(input), 'http://app.local'), init);
        return routes[request.method as 'GET' | 'POST' | 'PUT' | 'DELETE'](request);
      };
      const bytes = fileOf(SIZE, 36);
      const file = new File([bytes], 'client.bin', { lastModified: 1_700_000_000_000 });
      const sent: string[] = [];
      let handle: ReturnType<typeof startUpload>;
      const pausing = fetchPartSender(async (input, init) => {
        const res = await fetch(input, init);
        sent.push(new URL(String(input)).host);
        if (sent.length === 1) handle.pause();
        return res;
      });
      handle = startUpload({ file, fetch: dispatch, sendPart: pausing, concurrency: 1 });
      expect((await handle.promise.catch((e) => e)).code).toBe('PAUSED');

      const resumed: string[] = [];
      let startedResumed = false;
      const second = startUpload({
        file,
        fetch: dispatch,
        concurrency: 1,
        onStart: (info) => void (startedResumed = info.resumed && info.transfer === 'direct'),
        sendPart: fetchPartSender(async (input, init) => {
          resumed.push(String(input));
          return fetch(input, init);
        }),
      });
      const result = await second.promise;
      expect(startedResumed).toBe(true);
      // Every part went to the storage's host, never through the app.
      expect([...sent, ...resumed.map((u) => new URL(u).host)].every((h) => h !== 'app.local')).toBe(true);
      expect(resumed).toHaveLength(2); // only the two parts the storage did not have
      const backend = await backendFor(base());
      expect(sha256(await readAll(backend.openRead(result.key)))).toBe(sha256(bytes));
    }, 120_000);
  });
});
