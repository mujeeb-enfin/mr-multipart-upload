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
import { createUploadRoutes } from '../../src/server/routes.js';
import { createUploader, type Uploader, type UploaderOptions } from '../../src/server/uploader.js';
import { clearEnv, partOf, patternBytes } from '../helpers.js';
import {
  AVAILABLE,
  CLOUD_PART_BYTES,
  backendFor,
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

/**
 * The HTTP status, or 'reset' when the storage refused by closing the
 * connection before reading the body (VersityGW does so for an expired
 * signature; a browser sees a network error, which the client retries with a
 * fresh URL). Both are refusals; the tests then assert nothing was stored.
 */
/** The UploadError code a promise rejects with, or 'resolved'. */
function errorCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'resolved',
    (err: unknown) => (err instanceof UploadError ? err.code : `unexpected: ${String(err)}`),
  );
}

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

    beforeAll(async () => {
      clearEnv();
      await createBucket(kind, bucket);
    });
    afterAll(async () => {
      await deleteBucket(kind, bucket);
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
