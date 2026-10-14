// ---------------------------------------------------------------------------
// client.test.ts — the browser client against the real route handlers
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. Resume from the server's missing-part list, retry policy,
// throttling that actually throttles, progress that never runs backwards, and the
// .env size limit reaching the user. The client talks to the real handlers
// in-process through its `fetch` and `sendPart` options — no mocks of the server.
// XHR upload-progress events are only testable in a browser and are covered by
// the demo app's Playwright suite.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UploadClientError } from '../src/client/errors.js';
import { type PartSender, fetchPartSender } from '../src/client/transport.js';
import { type UploadProgress, startUpload } from '../src/client/upload.js';
import { createUploadRoutes, type UploadRoutes } from '../src/server/routes.js';
import { MIB, clearEnv, fileFrom, patternBytes, sha256, tempRoot } from './helpers.js';

let root: string;
let cleanup: () => Promise<void>;
let server: UploadRoutes;

beforeEach(async () => {
  ({ dir: root, cleanup } = await tempRoot());
  clearEnv();
  process.env.MULTIPART_UPLOAD_PART_BYTES = String(MIB);
  server = createUploadRoutes({
    dir: root,
    sweepOnBegin: false,
    authorize: (req) => (req.headers.get('authorization') === 'Bearer t' ? { namespace: 'u1' } : null),
  });
});
afterEach(async () => {
  clearEnv();
  await cleanup();
});

/** fetch that dispatches to the route handlers in-process. */
const dispatch: typeof fetch = async (input, init) => {
  const request = new Request(new URL(String(input), 'http://localhost'), init);
  const handler = server[request.method as 'GET' | 'POST' | 'PUT' | 'DELETE'];
  return handler(request);
};

const auth = { authorization: 'Bearer t' };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startUpload', () => {
  it('uploads a file whose stored hash equals the source, with monotonic progress ending at 100', async () => {
    const bytes = patternBytes(5 * MIB + 321);
    const seen: UploadProgress[] = [];
    const handle = startUpload({
      file: fileFrom(bytes, 'clip.mp4'),
      headers: () => auth,
      fetch: dispatch,
      sendPart: fetchPartSender(dispatch),
      onProgress: (p) => seen.push(p),
    });
    const result = await handle.promise;
    expect(result.sha256).toBe(sha256(bytes));
    expect(handle.uploadId).toBe('clip-mp4');
    const percents = seen.map((p) => p.percent);
    expect(percents.at(-1)).toBe(100);
    expect(seen.at(-1)?.phase).toBe('done');
    expect(percents.every((p, i) => i === 0 || p >= (percents[i - 1] as number))).toBe(true);
    // 100 only once assembled — never during upload.
    expect(seen.filter((p) => p.percent === 100).every((p) => p.phase === 'done')).toBe(true);
  });

  it('resumes after a pause, sending only the missing parts', async () => {
    const bytes = patternBytes(6 * MIB);
    const file = fileFrom(bytes, 'long.wav');
    const sent: number[] = [];
    let handle: ReturnType<typeof startUpload>;
    const pausingSender: PartSender = async (req) => {
      const res = await fetchPartSender(dispatch)(req);
      sent.push(Number(req.url.split('/').at(-1)));
      if (sent.length === 2) handle.pause();
      return res;
    };
    handle = startUpload({ file, headers: auth, fetch: dispatch, sendPart: pausingSender, concurrency: 1 });
    const paused = await handle.promise.catch((e: unknown) => e);
    expect((paused as UploadClientError).code).toBe('PAUSED');
    expect(sent).toEqual([1, 2]);

    const resumedSent: number[] = [];
    let info: { resumed: boolean; receivedBytes: number } | undefined;
    const again = startUpload({
      file,
      headers: auth,
      fetch: dispatch,
      onStart: (i) => (info = i),
      sendPart: async (req) => {
        resumedSent.push(Number(req.url.split('/').at(-1)));
        return fetchPartSender(dispatch)(req);
      },
    });
    const result = await again.promise;
    expect(info).toMatchObject({ resumed: true, receivedBytes: 2 * MIB });
    expect(resumedSent.sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
    expect(result.sha256).toBe(sha256(bytes));
  });

  it('retries a 429 and then really runs one part at a time', async () => {
    // MUTATION: remove the worker slot check -> after the 429 four parts still
    // run concurrently and `maxAfterThrottle` is 4.
    const bytes = patternBytes(12 * MIB);
    const run = await throttledRun(bytes);
    expect(run.sha256).toBe(sha256(bytes));
    expect(run.rejected429).toBe(1);
    expect(run.phases.has('throttled')).toBe(true);
    // Parts already running when the 429 arrives are allowed to finish; every part
    // that STARTS after that drain window must run alone.
    expect(run.maxConcurrencyAfterDrain).toBe(1);
    // And before the 429 it really was concurrent — otherwise the check above
    // would pass for an uploader that never parallelised at all.
    expect(run.maxConcurrencyBefore).toBeGreaterThan(1);
  }, 30_000);

  it('treats a non-retryable 4xx as terminal after ONE attempt', async () => {
    let attempts = 0;
    const err = await startUpload({
      file: fileFrom(patternBytes(2 * MIB), 'x.bin'),
      headers: auth,
      fetch: dispatch,
      sendPart: async () => {
        attempts += 1;
        return { status: 400, body: { error: { code: 'PART_LENGTH_MISMATCH', message: 'bad length' } }, retryAfterSeconds: null };
      },
      concurrency: 1,
    }).promise.catch((e: unknown) => e);
    expect((err as UploadClientError).code).toBe('PART_LENGTH_MISMATCH');
    expect(attempts).toBe(1);
  });

  it('never lets progress go backwards across a retried part', async () => {
    let failedOnce = false;
    const seen: number[] = [];
    await startUpload({
      file: fileFrom(patternBytes(3 * MIB), 'r.bin'),
      headers: auth,
      fetch: dispatch,
      concurrency: 1,
      onProgress: (p) => seen.push(p.sentBytes),
      sendPart: async (req) => {
        if (!failedOnce && req.url.endsWith('/parts/2')) {
          failedOnce = true;
          req.onProgress(MIB / 2); // half-sent, then the server errors
          return { status: 503, body: null, retryAfterSeconds: null };
        }
        const res = await fetchPartSender(dispatch)(req);
        // A stray progress event arriving AFTER the part completed — XHR can
        // deliver one late. It must not un-credit a finished part.
        if (req.url.endsWith('/parts/1')) setTimeout(() => req.onProgress(0), 0);
        return res;
      },
    }).promise;
    // The failed attempt's half-sent bytes may be un-credited, but part 1, once
    // complete, never is: from the first report of 1 MiB onward, nothing below it.
    // MUTATION: drop the `settled` guard in onProgress -> a late progress event
    // overwrites a completed part's pinned size.
    const firstFull = seen.indexOf(MIB);
    expect(firstFull).toBeGreaterThanOrEqual(0);
    expect(Math.min(...seen.slice(firstFull))).toBeGreaterThanOrEqual(MIB);
    expect(seen).toContain(MIB + MIB / 2); // the partial attempt was shown
    expect(seen.at(-1)).toBe(3 * MIB);
  });

  it('surfaces the .env size limit before sending any part', async () => {
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(2 * MIB);
    let parts = 0;
    const err = await startUpload({
      file: fileFrom(patternBytes(3 * MIB), 'big.bin'),
      headers: auth,
      fetch: dispatch,
      sendPart: async (req) => {
        parts += 1;
        return fetchPartSender(dispatch)(req);
      },
    }).promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadClientError);
    expect((err as UploadClientError).code).toBe('FILE_TOO_LARGE');
    expect((err as UploadClientError).details).toEqual({ maxFileBytes: 2 * MIB });
    expect(parts).toBe(0);
  });

  it('discard deletes the server-side parts', async () => {
    const bytes = patternBytes(4 * MIB);
    let handle: ReturnType<typeof startUpload>;
    let count = 0;
    handle = startUpload({
      file: fileFrom(bytes, 'd.bin'),
      headers: auth,
      fetch: dispatch,
      concurrency: 1,
      sendPart: async (req) => {
        const res = await fetchPartSender(dispatch)(req);
        if (++count === 1) void handle.discard();
        return res;
      },
    });
    await handle.promise.catch(() => undefined);
    await tick(20);
    const status = await dispatch('/api/uploads/d-bin', { headers: auth });
    expect(status.status).toBe(404);
  });

  it('sends the caller headers so authorize can identify the user', async () => {
    const err = await startUpload({ file: fileFrom(patternBytes(10), 'a.bin'), fetch: dispatch }).promise.catch((e: unknown) => e);
    expect((err as UploadClientError).status).toBe(401);
  });
});

/**
 * Upload with a 429 injected on part 2, measuring concurrency before the 429
 * and for every part that STARTS after the parts in flight at that moment drain.
 */
async function throttledRun(bytes: Uint8Array<ArrayBuffer>) {
  let inFlight = 0;
  let started = 0;
  let throttledAt = -1;
  let maxConcurrencyBefore = 0;
  let maxConcurrencyAfterDrain = 0;
  let rejected429 = 0;
  const phases = new Set<string>();

  const sender: PartSender = async (req) => {
    started += 1;
    inFlight += 1;
    if (throttledAt < 0) maxConcurrencyBefore = Math.max(maxConcurrencyBefore, inFlight);
    // `+ 4`: up to four parts (the initial concurrency) were already running.
    else if (started > throttledAt + 4) maxConcurrencyAfterDrain = Math.max(maxConcurrencyAfterDrain, inFlight);
    try {
      await tick(15);
      if (throttledAt < 0 && req.url.endsWith('/parts/2')) {
        throttledAt = started;
        rejected429 += 1;
        return { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } }, retryAfterSeconds: null };
      }
      return await fetchPartSender(dispatch)(req);
    } finally {
      inFlight -= 1;
    }
  };

  const result = await startUpload({
    file: fileFrom(bytes, 'big.bin'),
    headers: auth,
    fetch: dispatch,
    sendPart: sender,
    concurrency: 4,
    onProgress: (p) => phases.add(p.phase),
  }).promise;
  return { sha256: result.sha256, rejected429, phases, maxConcurrencyBefore, maxConcurrencyAfterDrain };
}
