// ---------------------------------------------------------------------------
// client-direct.test.ts — the browser client's retry rules in direct transfer
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. In direct transfer each attempt makes two requests: one
// to the app's own server (sign the part) and one to the storage (send it).
// Their failures mean different things, and the client must tell them apart:
//   - a 400/403 from the STORAGE is an expired or skewed signature or a failed
//     checksum: a fresh URL and a resend cure it, so it is retried;
//   - a 400/403 from the APP'S SERVER (middleware, auth, a WAF) is final, as on
//     every other request — retrying it re-sends nothing useful and only delays
//     the error;
//   - a 503 from the storage is S3's SlowDown / Azure's ServerBusy — throttling,
//     which must cut concurrency exactly as a 429 does.
// The real route handlers answer begin; the signing route and the storage are
// stubbed, because only the client's decisions are under test.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UploadClientError } from '../src/client/errors.js';
import type { PartSender } from '../src/client/transport.js';
import { type UploadPhase, startUpload } from '../src/client/upload.js';
import { createUploadRoutes, type UploadRoutes } from '../src/server/routes.js';
import { MIB, clearEnv, fileFrom, patternBytes, tempRoot } from './helpers.js';

let cleanup: () => Promise<void>;
let server: UploadRoutes;

beforeEach(async () => {
  const temp = await tempRoot();
  cleanup = temp.cleanup;
  clearEnv();
  process.env.MULTIPART_UPLOAD_PART_BYTES = String(MIB);
  server = createUploadRoutes({ dir: temp.dir, sweepOnBegin: false, allowAnonymous: true });
});
afterEach(async () => {
  clearEnv();
  await cleanup();
});

const STORAGE_URL = 'https://storage.test/part';

/** begin from the real handlers, reported as direct transfer; the signing route answered by `sign`. */
function directServer(sign: () => Response): { fetch: typeof fetch; signCalls: () => number } {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    if (/\/parts\/\d+\/url$/.test(request.url)) {
      calls += 1;
      return sign();
    }
    const response = await server[request.method as 'GET' | 'POST' | 'PUT' | 'DELETE'](request);
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/uploads') return response;
    const begun = (await response.json()) as Record<string, unknown>;
    return Response.json({ ...begun, transfer: 'direct', directChecksums: ['sha256'] }, { status: response.status });
  };
  return { fetch: fetchImpl, signCalls: () => calls };
}

const signed = () => Response.json({ url: STORAGE_URL, method: 'PUT', headers: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() });

/** A storage answering each PUT with the next status from `statuses` (then 200). */
function storage(statuses: number[]): { sendPart: PartSender; puts: () => number; sent: () => { url: string; credentials: unknown }[] } {
  const sent: { url: string; credentials: unknown }[] = [];
  return {
    sendPart: async (req) => {
      // Recorded, not asserted here: a throw would reach the client as a
      // network error and be retried, hiding what went wrong.
      sent.push({ url: req.url, credentials: req.credentials });
      const status = statuses[sent.length - 1] ?? 200;
      return { status, body: null, retryAfterSeconds: status === 200 ? null : 0.01 };
    },
    puts: () => sent.length,
    sent: () => sent,
  };
}

/** Every PUT went to the signed storage URL, without the app's cookies. */
function expectStorageRequests(store: ReturnType<typeof storage>) {
  for (const request of store.sent()) expect(request).toEqual({ url: STORAGE_URL, credentials: 'omit' });
}

async function failureOf(promise: Promise<unknown>): Promise<UploadClientError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof UploadClientError) return err;
    throw err;
  }
  throw new Error('the upload unexpectedly succeeded');
}

describe('direct transfer retry rules', () => {
  it('fails at once on a 403 from the app\'s signing request, sending nothing to the storage', async () => {
    // MUTATION: drop `reachedStorage` from retryableDirect -> 5 signing calls.
    const server403 = directServer(() => new Response('Forbidden', { status: 403 }));
    const store = storage([]);
    const err = await failureOf(
      startUpload({ file: fileFrom(patternBytes(1000), 'a.bin'), fetch: server403.fetch, sendPart: store.sendPart, maxAttemptsPerPart: 5 }).promise,
    );
    expect(err.status).toBe(403);
    expect(server403.signCalls()).toBe(1);
    expect(store.puts()).toBe(0);
  });

  // The parts never reach the in-process server, so its complete reports them
  // missing (INCOMPLETE): that is the expected end of the runs below, and it
  // proves each part was accepted by the storage stub first.
  it('retries a 403 and a 400 from the storage with a freshly signed URL each time', async () => {
    // MUTATION: drop `failure.status === 400` from retryableDirect -> fails after one PUT.
    const app = directServer(signed);
    const store = storage([403, 400]);
    const err = await failureOf(
      startUpload({ file: fileFrom(patternBytes(1000), 'b.bin'), fetch: app.fetch, sendPart: store.sendPart, maxAttemptsPerPart: 5 }).promise,
    );
    expect(err.code).toBe('INCOMPLETE');
    expect(store.puts()).toBe(3); // 403, 400, then accepted
    expect(app.signCalls()).toBe(3); // one fresh URL per attempt
    expectStorageRequests(store);
  });

  it('treats a 503 from the storage as throttling, like a 429', async () => {
    // MUTATION: drop `reachedStorage && failure.status === 503` -> no 'throttled' phase.
    const app = directServer(signed);
    const store = storage([503]);
    const phases = new Set<UploadPhase>();
    const err = await failureOf(
      startUpload({
        file: fileFrom(patternBytes(1000), 'c.bin'),
        fetch: app.fetch,
        sendPart: store.sendPart,
        onProgress: (p) => phases.add(p.phase),
      }).promise,
    );
    expect(err.code).toBe('INCOMPLETE');
    expect(store.puts()).toBe(2);
    expect(phases.has('throttled')).toBe(true);
    expectStorageRequests(store);
  });

  it('retries a 503 from the app\'s signing request without throttling', async () => {
    // An overloaded app server is not the storage asking the client to slow down.
    // MUTATION: drop `reachedStorage &&` from the 503 throttle rule -> 'throttled' appears.
    let signs = 0;
    const app = directServer(() => {
      signs += 1;
      return signs === 1 ? new Response('busy', { status: 503 }) : signed();
    });
    const store = storage([]);
    const phases = new Set<UploadPhase>();
    const err = await failureOf(
      startUpload({ file: fileFrom(patternBytes(1000), 'd.bin'), fetch: app.fetch, sendPart: store.sendPart, onProgress: (p) => phases.add(p.phase) })
        .promise,
    );
    expect(err.code).toBe('INCOMPLETE');
    expect(app.signCalls()).toBe(2);
    expect(store.puts()).toBe(1);
    expect(phases.has('throttled')).toBe(false);
  });
});
