// ---------------------------------------------------------------------------
// routes.test.ts — the Next.js route handlers, called with real Requests
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. The HTTP contract the browser client depends on: status
// codes, error codes, body limits, the auth gate and the path parsing. App
// Router handlers are plain (Request) => Response functions, so they are
// exercised directly — the same objects Next.js passes them.
// ---------------------------------------------------------------------------

import { readdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUploadRoutes, type UploadRoutes, type UploadRoutesOptions } from '../src/server/routes.js';
import { MIB, clearEnv, partOf, patternBytes, sha256, tempRoot } from './helpers.js';

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir: root, cleanup } = await tempRoot());
  clearEnv();
  process.env.MULTIPART_UPLOAD_PART_BYTES = String(MIB);
});
afterEach(async () => {
  clearEnv();
  await cleanup();
});

const BASE = 'http://localhost/api/uploads';

function routes(extra: Partial<UploadRoutesOptions> = {}): UploadRoutes {
  return createUploadRoutes({
    dir: root,
    sweepOnBegin: false,
    authorize: (req) => {
      const user = req.headers.get('x-user');
      return user ? { namespace: user } : null;
    },
    ...extra,
  });
}

const asUser = { 'x-user': 'alice' };

function beginRequest(body: unknown, headers: Record<string, string> = asUser) {
  return new Request(BASE, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function partRequest(id: string, index: number | string, bytes: Uint8Array<ArrayBuffer>, fingerprint: string | null = 'fp') {
  const headers: Record<string, string> = { ...asUser };
  if (fingerprint) headers['x-upload-fingerprint'] = fingerprint;
  return new Request(`${BASE}/${id}/parts/${index}`, { method: 'PUT', headers, body: bytes });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('construction', () => {
  it('REFUSES to build without authorize, unless anonymous is explicit', () => {
    // MUTATION: default to anonymous -> a route anyone can fill with files.
    expect(() => createUploadRoutes({ dir: root })).toThrow(/needs an `authorize` function/);
    expect(() => createUploadRoutes({ dir: root, allowAnonymous: true })).not.toThrow();
  });
});

describe('the full flow over HTTP', () => {
  it('begins, resumes, accepts parts, completes, and returns the stored hash', async () => {
    const r = routes({ onComplete: ({ metadata }) => ({ saved: metadata.title }) });
    const bytes = patternBytes(2 * MIB + 99);
    const begin = { fileName: 'Talk.m4a', totalBytes: bytes.byteLength, fingerprint: 'fp', metadata: { title: 'Talk' } };

    const first = await r.POST(beginRequest(begin));
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const session = (await first.json()) as { uploadId: string; partCount: number; missingParts: number[]; maxFileBytes: number };
    expect(session).toMatchObject({ uploadId: 'talk-m4a', partCount: 3, missingParts: [1, 2, 3], maxFileBytes: 500 * MIB });

    expect((await r.PUT(partRequest('talk-m4a', 1, partOf(bytes, 1, MIB)))).status).toBe(200);

    const resumed = await r.POST(beginRequest(begin));
    expect(resumed.status).toBe(200); // resume, not create
    expect(((await resumed.json()) as { missingParts: number[] }).missingParts).toEqual([2, 3]);

    for (const i of [2, 3]) expect((await r.PUT(partRequest('talk-m4a', i, partOf(bytes, i, MIB)))).status).toBe(200);

    const done = await r.POST(new Request(`${BASE}/talk-m4a/complete`, { method: 'POST', headers: asUser }));
    expect(done.status).toBe(201);
    expect(await done.json()).toMatchObject({ sha256: sha256(bytes), size: bytes.byteLength, result: { saved: 'Talk' } });
  });

  it('lists, reports status and discards', async () => {
    const r = routes();
    await r.POST(beginRequest({ fileName: 'a.bin', totalBytes: 10, fingerprint: 'fp' }));
    const list = (await (await r.GET(new Request(BASE, { headers: asUser }))).json()) as { uploads: { uploadId: string }[] };
    expect(list.uploads.map((u) => u.uploadId)).toEqual(['a-bin']);
    expect((await r.GET(new Request(`${BASE}/a-bin`, { headers: asUser }))).status).toBe(200);
    expect((await r.DELETE(new Request(`${BASE}/a-bin`, { method: 'DELETE', headers: asUser }))).status).toBe(204);
    const gone = await r.GET(new Request(`${BASE}/a-bin`, { headers: asUser }));
    expect(gone.status).toBe(404);
    expect(await errorCode(gone)).toBe('NO_SESSION');
  });
});

describe('limits', () => {
  it('rejects a file over MULTIPART_UPLOAD_MAX_FILE_BYTES with 413 and the limit', async () => {
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(10 * MIB);
    const res = await routes().POST(beginRequest({ fileName: 'big.bin', totalBytes: 11 * MIB, fingerprint: 'fp' }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE', details: { maxFileBytes: 10 * MIB } } });
  });

  it('refuses a part by its Content-Length before reading it', async () => {
    const r = routes();
    await r.POST(beginRequest({ fileName: 'a.bin', totalBytes: 3 * MIB, fingerprint: 'fp' }));
    const res = await r.PUT(
      new Request(`${BASE}/a-bin/parts/1`, {
        method: 'PUT',
        headers: { ...asUser, 'x-upload-fingerprint': 'fp', 'content-length': String(9 * MIB) },
        body: new Uint8Array(10),
      }),
    );
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('BODY_TOO_LARGE');
  });

  it('stops reading a streamed part that exceeds the cap with no Content-Length', async () => {
    // A lying or absent header must not let a client stream gigabytes into memory.
    const r = routes();
    await r.POST(beginRequest({ fileName: 'a.bin', totalBytes: 3 * MIB, fingerprint: 'fp' }));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 20) return controller.close(); // 20 MiB if never cancelled
        controller.enqueue(new Uint8Array(MIB));
      },
    });
    const res = await r.PUT(
      new Request(`${BASE}/a-bin/parts/1`, { method: 'PUT', headers: { ...asUser, 'x-upload-fingerprint': 'fp' }, body, duplex: 'half' } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(10); // stopped just past 8 MiB
  });

  it('treats a client that disconnects mid-part as a client event, not a server error', async () => {
    // Pausing or discarding aborts the browser's in-flight part requests, so the
    // server sees the body stream fail (ECONNRESET). Reporting that through
    // onError made every pause log an error on the server. Found by the browser
    // test suite, which printed "[multipart-upload] Error: aborted".
    const onError = vi.fn();
    const r = routes({ onError });
    await r.POST(beginRequest({ fileName: 'a.bin', totalBytes: 3 * MIB, fingerprint: 'fp' }));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ === 0) return controller.enqueue(new Uint8Array(256 * 1024));
        controller.error(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      },
    });
    const res = await r.PUT(
      new Request(`${BASE}/a-bin/parts/1`, { method: 'PUT', headers: { ...asUser, 'x-upload-fingerprint': 'fp' }, body, duplex: 'half' } as RequestInit),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('CLIENT_DISCONNECTED');
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects oversized JSON at begin', async () => {
    const res = await routes({ maxMetadataBytes: 100 }).POST(
      beginRequest({ fileName: 'a.bin', totalBytes: 10, fingerprint: 'fp', metadata: { x: 'y'.repeat(20_000) } }),
    );
    expect(res.status).toBe(413);
  });
});

describe('request validation', () => {
  it('requires the fingerprint header and a strict part number', async () => {
    const r = routes();
    await r.POST(beginRequest({ fileName: 'a.bin', totalBytes: MIB, fingerprint: 'fp' }));
    expect(await errorCode(await r.PUT(partRequest('a-bin', 1, new Uint8Array(MIB), null)))).toBe('INVALID_REQUEST');
    for (const bad of ['1e3', '+1', '0x1', '1.0', '1234567']) {
      const res = await r.PUT(partRequest('a-bin', bad, new Uint8Array(MIB)));
      expect(await errorCode(res), bad).toBe('PART_OUT_OF_RANGE');
    }
  });

  it('passes a valid part checksum through, and refuses a malformed one', async () => {
    const r = routes();
    const bytes = patternBytes(MIB);
    await r.POST(beginRequest({ fileName: 'a.bin', totalBytes: MIB, fingerprint: 'fp' }));
    const put = (checksum: string) =>
      r.PUT(new Request(`${BASE}/a-bin/parts/1`, { method: 'PUT', headers: { ...asUser, 'x-upload-fingerprint': 'fp', 'x-part-sha256': checksum }, body: bytes }));
    expect(await errorCode(await put('NOT-HEX'))).toBe('INVALID_REQUEST');
    const mismatch = await put('0'.repeat(64));
    expect(mismatch.status).toBe(422);
    expect(await errorCode(mismatch)).toBe('PART_CHECKSUM_MISMATCH');
    expect((await put(sha256(bytes))).status).toBe(200);
  });

  it('rejects malformed JSON and unsafe upload ids', async () => {
    const r = routes();
    const bad = await r.POST(new Request(BASE, { method: 'POST', headers: asUser, body: '{nope' }));
    expect(await errorCode(bad)).toBe('INVALID_REQUEST');
    for (const id of ['..', 'UPPER', '%2e%2e', 'a%2Fb']) {
      const res = await r.GET(new Request(`${BASE}/${id}`, { headers: asUser }));
      expect([400, 404], id).toContain(res.status);
      expect(await errorCode(res), id).toMatch(/INVALID_NAME|NOT_FOUND|INVALID_REQUEST/);
    }
  });
});

describe('auth and routing', () => {
  it('returns 401 when authorize refuses, and 401 when it throws', async () => {
    expect((await routes().POST(beginRequest({ fileName: 'a.bin', totalBytes: 1, fingerprint: 'fp' }, {}))).status).toBe(401);
    const throwing = routes({ authorize: () => { throw new Error('token expired'); } });
    const res = await throwing.GET(new Request(BASE));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('token expired'); // no internals leaked
  });

  it('explains a basePath mismatch instead of a bare 404', async () => {
    const res = await routes().GET(new Request('http://localhost/api/files', { headers: asUser }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/Set the `basePath` option/);
  });

  it('honours a custom basePath', async () => {
    const r = routes({ basePath: '/v2/media/' });
    expect((await r.GET(new Request('http://localhost/v2/media', { headers: asUser }))).status).toBe(200);
  });

  it('returns 404 for an unsupported method on a path', async () => {
    expect(await errorCode(await routes().DELETE(new Request(BASE, { method: 'DELETE', headers: asUser })))).toBe('NOT_FOUND');
  });

  it('reports unexpected errors through onError and returns a generic 500', async () => {
    const onError = vi.fn();
    const r = routes({
      onError,
      onComplete: () => {
        throw new Error('secret database detail');
      },
    });
    await r.POST(beginRequest({ fileName: 'a.bin', totalBytes: 5, fingerprint: 'fp' }));
    await r.PUT(partRequest('a-bin', 1, patternBytes(5)));
    const res = await r.POST(new Request(`${BASE}/a-bin/complete`, { method: 'POST', headers: asUser }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret database detail');
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('parameters first, .env as the fallback', () => {
  // Protects the configuration contract: an app that passes settings to
  // createUploadRoutes() gets exactly those, whatever .env says. The .env
  // values are set to something different for every setting, so a parameter
  // that is silently ignored shows up as the .env value.
  it('every parameter wins over its .env variable, and storage lands in the parameter dir', async () => {
    const { dir: envDir, cleanup: cleanupEnvDir } = await tempRoot();
    try {
      process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(100 * MIB);
      process.env.MULTIPART_UPLOAD_PART_BYTES = String(MIB);
      process.env.MULTIPART_UPLOAD_DIR = envDir;
      process.env.MULTIPART_UPLOAD_PART_TTL_HOURS = '1';
      process.env.MULTIPART_UPLOAD_INSTANCE_ID = 'from-env';

      const r = routes({ maxFileBytes: 3 * MIB, partBytes: 2 * MIB, partTtlMs: 5_000, instanceId: 'from-param' });
      expect(r.uploader.config()).toMatchObject({
        maxFileBytes: 3 * MIB,
        partBytes: 2 * MIB,
        dir: root,
        partTtlMs: 5_000,
        instanceId: 'from-param',
      });

      // The limit in force is the parameter's: .env would have accepted 4 MiB.
      const tooBig = await r.POST(beginRequest({ fileName: 'big.bin', totalBytes: 4 * MIB, fingerprint: 'fp' }));
      expect(tooBig.status).toBe(413);
      expect(await tooBig.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE', details: { maxFileBytes: 3 * MIB } } });

      // The part size in force is the parameter's: 3 MiB in 2 MiB parts is 2 parts (in 1 MiB parts, 3).
      const begun = await r.POST(beginRequest({ fileName: 'ok.bin', totalBytes: 3 * MIB, fingerprint: 'fp' }));
      expect(await begun.json()).toMatchObject({ partBytes: 2 * MIB, partCount: 2, maxFileBytes: 3 * MIB });

      // Written under the parameter dir; the .env dir is untouched.
      expect(await readdir(root)).toContain('.parts');
      expect(await readdir(envDir)).toEqual([]);
    } finally {
      await cleanupEnvDir();
    }
  });

  it('uses .env when the parameter is left out', async () => {
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(7 * MIB);
    expect(routes().uploader.config().maxFileBytes).toBe(7 * MIB);
  });
});
