// ---------------------------------------------------------------------------
// large-file.test.ts — the scenario this library exists for
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. A large upload interrupted after 10 parts resumes by
// sending ONLY the missing parts, and the stored file is byte-identical to the
// source. Driven through the real route handlers and the real client.
//
// Size defaults to 40 MB so the suite stays fast (40 MB is 20 parts at 2 MiB —
// deliberately MORE than 10, so "interrupted after 10 parts" is a real
// interruption; at 20 MB the file would already be complete). For the full
// proof run:   MPU_LARGE_MB=400 npx vitest run test/large-file.test.ts
//
// The source file is written to disk and opened as a disk-backed Blob, so a
// 400 MB run does not need 400 MB of memory.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import type { UploadClientError } from '../src/client/errors.js';
import { type PartSender, fetchPartSender } from '../src/client/transport.js';
import { startUpload } from '../src/client/upload.js';
import { createUploadRoutes } from '../src/server/routes.js';
import { MIB, clearEnv, patternBytes, tempRoot } from './helpers.js';

const SIZE_MB = Number(process.env.MPU_LARGE_MB ?? 40);
const TOTAL = SIZE_MB * 1_000_000 + 12_345; // not a multiple of the part size: short last part
const PART = 2 * MIB;
const PART_COUNT = Math.ceil(TOTAL / PART);
const INTERRUPT_AFTER = 10;

let root: string;
let cleanup: () => Promise<void>;
let sourcePath: string;
let sourceSha: string;

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

beforeAll(async () => {
  ({ dir: root, cleanup } = await tempRoot());
  clearEnv();
  sourcePath = join(root, 'source.bin');
  // Written in 1 MiB blocks with a different seed each, so every block differs.
  const out = createWriteStream(sourcePath);
  for (let written = 0, block = 0; written < TOTAL; block += 1) {
    const size = Math.min(MIB, TOTAL - written);
    if (!out.write(patternBytes(size, block + 1))) await new Promise((r) => out.once('drain', r));
    written += size;
  }
  await new Promise<void>((r) => out.end(() => r()));
  sourceSha = await sha256OfFile(sourcePath);
}, 300_000);

afterAll(async () => {
  clearEnv();
  await cleanup();
});

it(`resumes a ${SIZE_MB} MB upload interrupted after ${INTERRUPT_AFTER} parts and stores identical bytes`, async () => {
  expect(PART_COUNT).toBeGreaterThan(INTERRUPT_AFTER); // otherwise nothing is interrupted

  const server = createUploadRoutes({ dir: join(root, 'store'), sweepOnBegin: false, allowAnonymous: true });
  const dispatch: typeof fetch = async (input, init) => {
    const request = new Request(new URL(String(input), 'http://localhost'), init);
    return server[request.method as 'GET' | 'POST' | 'PUT' | 'DELETE'](request);
  };

  const blob = await openAsBlob(sourcePath);
  const file = Object.assign(blob, { name: 'Session Recording.wav', lastModified: 1_700_000_000_000 });

  // Attempt 1: interrupted after exactly 10 parts.
  const firstSent: number[] = [];
  let first: ReturnType<typeof startUpload>;
  const interrupting: PartSender = async (req) => {
    const res = await fetchPartSender(dispatch)(req);
    firstSent.push(Number(req.url.split('/').at(-1)));
    if (firstSent.length === INTERRUPT_AFTER) first.pause();
    return res;
  };
  first = startUpload({ file, fetch: dispatch, sendPart: interrupting, concurrency: 1 });
  const interrupted = await first.promise.catch((e: unknown) => e as UploadClientError);
  expect((interrupted as UploadClientError).code).toBe('PAUSED');
  expect(firstSent).toEqual(Array.from({ length: INTERRUPT_AFTER }, (_, i) => i + 1));

  // Attempt 2: the same file again. Only the missing parts may be sent.
  const secondSent: number[] = [];
  let resumedFrom = -1;
  const second = startUpload({
    file,
    fetch: dispatch,
    onStart: (info) => (resumedFrom = info.receivedBytes),
    sendPart: async (req) => {
      secondSent.push(Number(req.url.split('/').at(-1)));
      return fetchPartSender(dispatch)(req);
    },
  });
  const result = await second.promise;

  expect(resumedFrom).toBe(INTERRUPT_AFTER * PART);
  expect(secondSent).toHaveLength(PART_COUNT - INTERRUPT_AFTER);
  expect(Math.min(...secondSent)).toBe(INTERRUPT_AFTER + 1);
  expect(new Set(secondSent).size).toBe(PART_COUNT - INTERRUPT_AFTER); // no part sent twice

  expect(result.size).toBe(TOTAL);
  expect(result.sha256).toBe(sourceSha);
  // The hash the server reported, re-derived from the file actually on disk.
  expect(await sha256OfFile(join(root, 'store', result.key))).toBe(sourceSha);
}, 600_000);
