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
    expect(handle.uploadId).toBe(result.uploadId);
    expect(handle.uploadId).toMatch(/^[0-9a-f]{64}$/);
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
    // Sized so the overlap is GUARANTEED, not likely: the throttled part retries
    // after a fixed 200 ms Retry-After, and the surviving worker still has ~20
    // parts x 60 ms = 1.2 s of work at that moment. An earlier version used 12
    // parts and jittered backoff; worker 0 usually finished first, so removing
    // the requeue fix went undetected (found by mutation testing).
    const bytes = patternBytes(24 * MIB);
    const run = await throttledRun(bytes);
    expect(run.sha256).toBe(sha256(bytes));
    expect(run.rejected429).toBe(1);
    expect(run.phases.has('throttled')).toBe(true);
    // MUTATION: retry the throttled part in place instead of requeueing it -> it
    // goes back on the wire while the surviving worker is mid-part: 2 at once.
    // Measured at the exact moment of the retry, not over a counted window — an
    // earlier count-based version caught this only when the timing happened to
    // line up (5/5 in isolation, missed in a full-file run).
    expect(run.inFlightAtRetry).toBe(1);
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
    // Awaits the discard itself. An earlier version fired it and then slept a
    // fixed 20 ms before checking; under parallel test load the DELETE sometimes
    // took longer, and the check failed in 5 of 15 runs.
    const bytes = patternBytes(4 * MIB);
    let handle: ReturnType<typeof startUpload>;
    let discarding: Promise<void> | null = null;
    handle = startUpload({
      file: fileFrom(bytes, 'd.bin'),
      headers: auth,
      fetch: dispatch,
      concurrency: 1,
      sendPart: async (req) => {
        const res = await fetchPartSender(dispatch)(req);
        discarding ??= handle.discard();
        return res;
      },
    });
    const outcome = await handle.promise.catch((e: unknown) => e);
    expect((outcome as UploadClientError).code).toBe('PAUSED');
    expect(discarding).not.toBeNull();
    await discarding;
    const status = await dispatch('/api/uploads/d-bin', { headers: auth });
    expect(status.status).toBe(404);
    expect(((await status.json()) as { error: { code: string } }).error.code).toBe('NO_SESSION');
  });

  it('discard while begin is still in flight leaves nothing on the server', async () => {
    // The server can create the upload before the client learns its id. If the
    // client aborts begin and forgets it, the "discarded" upload lingers until the
    // sweep. Begin is slowed so discard() lands while it is in flight.
    // Behaves like a browser's fetch: if the request's signal aborts before the
    // response arrives, the promise REJECTS — even though the server already
    // processed it. The plain in-process dispatch ignores signals, which is why an
    // earlier version of this test could not tell an abortable begin apart.
    const slowBegin: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST' && !String(input).includes('/complete')) {
        const response = await dispatch(input, init); // the server has created it...
        await tick(50); // ...but the client has not heard back yet
        if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        return response;
      }
      return dispatch(input, init);
    };
    const handle = startUpload({ file: fileFrom(patternBytes(3 * MIB), 'early.bin'), headers: auth, fetch: slowBegin, sendPart: fetchPartSender(dispatch) });
    await tick(10);
    await handle.discard();
    await handle.promise.catch(() => undefined);

    const listed = (await (await dispatch('/api/uploads', { headers: auth })).json()) as { uploads: unknown[] };
    expect(listed.uploads).toEqual([]);
  });

  it('never stores a file whose parts arrived with the wrong bytes — the WebKit failure mode', async () => {
    // A WebKit build was found sending part 1's bytes as every part, at the right
    // length: every size check passed and the upload "succeeded" corrupted. This
    // transport does the same. The checksum must make it fail LOUDLY instead.
    // MUTATION: drop the server's checksum verification -> the upload completes
    // with a SHA-256 that matches neither file.
    const bytes = patternBytes(3 * MIB);
    let attempts = 0;
    const wrongBytes: PartSender = async (req) => {
      attempts += 1;
      const firstPart = bytes.slice(0, req.body.byteLength).buffer; // part 1's bytes, right length
      return fetchPartSender(dispatch)({ ...req, body: firstPart });
    };
    const err = await startUpload({ file: fileFrom(bytes, 'webkit.bin'), headers: auth, fetch: dispatch, sendPart: wrongBytes, concurrency: 1, maxAttemptsPerPart: 3 })
      .promise.catch((e: unknown) => e);
    expect((err as UploadClientError).code).toBe('PART_CHECKSUM_MISMATCH');
    expect(attempts).toBe(1 + 3); // part 1 is genuinely right; part 2 fails 3 times, retried
    const listed = (await (await dispatch('/api/uploads', { headers: auth })).json()) as { uploads: { receivedBytes: number }[] };
    expect(listed.uploads[0]?.receivedBytes).toBe(MIB); // only the genuine part 1 was stored
  });

  it('recovers when bytes are corrupted once in transit', async () => {
    const bytes = patternBytes(3 * MIB);
    let corrupted = false;
    const flaky: PartSender = async (req) => {
      if (!corrupted && req.url.endsWith('/parts/2')) {
        corrupted = true;
        const damaged = new Uint8Array(req.body.slice(0));
        damaged[100] = (damaged[100] as number) ^ 0xff;
        return fetchPartSender(dispatch)({ ...req, body: damaged.buffer });
      }
      return fetchPartSender(dispatch)(req);
    };
    const result = await startUpload({ file: fileFrom(bytes, 'flaky.bin'), headers: auth, fetch: dispatch, sendPart: flaky }).promise;
    expect(corrupted).toBe(true);
    expect(result.sha256).toBe(sha256(bytes));
  });

  it('refuses an empty file with a message that says so', async () => {
    const err = await startUpload({ file: fileFrom(new Uint8Array(0), 'empty.txt'), headers: auth, fetch: dispatch }).promise.catch((e: unknown) => e);
    expect((err as UploadClientError).code).toBe('INVALID_REQUEST');
    expect((err as UploadClientError).message).toMatch(/empty/i);
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
  let inFlightAtRetry = -1;
  const phases = new Set<string>();

  const sender: PartSender = async (req) => {
    started += 1;
    inFlight += 1;
    // The second call for part 2 is the retry of the throttled part.
    if (throttledAt >= 0 && req.url.endsWith('/parts/2')) inFlightAtRetry = inFlight;
    if (throttledAt < 0) maxConcurrencyBefore = Math.max(maxConcurrencyBefore, inFlight);
    // `+ 4`: up to four parts (the initial concurrency) were already running.
    else if (started > throttledAt + 4) maxConcurrencyAfterDrain = Math.max(maxConcurrencyAfterDrain, inFlight);
    try {
      await tick(60);
      if (throttledAt < 0 && req.url.endsWith('/parts/2')) {
        throttledAt = started;
        rejected429 += 1;
        // A fixed Retry-After removes backoff jitter from the timing.
        return { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } }, retryAfterSeconds: 0.2 };
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
  return { sha256: result.sha256, rejected429, phases, maxConcurrencyBefore, maxConcurrencyAfterDrain, inFlightAtRetry };
}
