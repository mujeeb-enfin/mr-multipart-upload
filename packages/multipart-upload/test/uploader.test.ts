// ---------------------------------------------------------------------------
// uploader.test.ts — the server API against a real filesystem
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. Resume, isolation between users, the refusal to mix two
// files, idempotent parts, the completion lock, dedupe, the hooks and the sweep.
// Every assertion is on stored bytes, stored files or the specific error code —
// never only on "it did not throw".
// ---------------------------------------------------------------------------

import { readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { partCountFor } from '../src/core/arithmetic.js';
import { UploadError } from '../src/core/errors.js';
import { lockKey, partKey, sessionKey } from '../src/core/layout.js';
import { namespaceKeyFor } from '../src/server/namespace.js';
import { createUploader, type Uploader, type UploaderOptions } from '../src/server/uploader.js';
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

const ALICE = { namespace: 'user-alice' };
const BOB = { namespace: 'user-bob' };
const SIZE = 3 * MIB + 12_345; // 4 parts at 1 MiB, short last part

function uploaderWith(extra: UploaderOptions = {}): Uploader {
  return createUploader({ dir: root, sweepOnBegin: false, ...extra });
}

function fingerprintOf(bytes: Uint8Array, name: string) {
  return `${bytes.byteLength}-1-${name.length}`;
}

async function sendParts(up: Uploader, ctx: { namespace: string }, uploadId: string, bytes: Uint8Array<ArrayBuffer>, name: string, indices: number[]) {
  for (const index of indices) {
    await up.putPart(ctx, { uploadId, index, bytes: partOf(bytes, index, MIB), fingerprint: fingerprintOf(bytes, name) });
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof UploadError ? err.code : `non-upload-error: ${String(err)}`;
  }
}

describe('begin and resume', () => {
  it('resumes after an interruption, reporting only the missing parts', async () => {
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    const first = await up.begin(ALICE, { fileName: 'Mix.wav', totalBytes: SIZE, fingerprint: fingerprintOf(bytes, 'Mix.wav') });
    expect(first.created).toBe(true);
    expect(first.session.manifest.uploadId).toBe('mix-wav');
    expect(first.session.missingParts).toEqual([1, 2, 3, 4]);

    await sendParts(up, ALICE, 'mix-wav', bytes, 'Mix.wav', [1, 2]);

    const again = await up.begin(ALICE, { fileName: 'Mix.wav', totalBytes: SIZE, fingerprint: fingerprintOf(bytes, 'Mix.wav') });
    expect(again.created).toBe(false);
    expect(again.session.missingParts).toEqual([3, 4]);
    expect(again.session.receivedBytes).toBe(2 * MIB);
  });

  it('REFUSES a different file under the same name, naming both', async () => {
    const up = uploaderWith();
    await up.begin(ALICE, { fileName: 'song.mp3', totalBytes: SIZE, fingerprint: 'fp-one' });
    const err = await up.begin(ALICE, { fileName: 'SONG.mp3', totalBytes: SIZE, fingerprint: 'fp-two' }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.code).toBe('NAME_IN_USE');
    expect(err.message).toContain('song.mp3');
    expect(err.message).toContain('SONG.mp3');
  });

  it('isolates namespaces: same file name, two users, two independent uploads', async () => {
    // MUTATION: drop the namespace from the session key -> Bob's begin hits
    // Alice's manifest and gets NAME_IN_USE.
    const up = uploaderWith();
    const a = await up.begin(ALICE, { fileName: 'photo.jpg', totalBytes: SIZE, fingerprint: 'fp-alice' });
    const b = await up.begin(BOB, { fileName: 'photo.jpg', totalBytes: SIZE + 1, fingerprint: 'fp-bob' });
    expect(a.created && b.created).toBe(true);
    expect(await codeOf(up.status(BOB, 'photo-jpg'))).toBe('resolved');
    expect((await up.status(BOB, 'photo-jpg')).manifest.fingerprint).toBe('fp-bob');
    expect(await up.list(ALICE)).toHaveLength(1);
    // Bob cannot discard or complete Alice's upload: his namespace has no such session after discarding his own.
    await up.discard(BOB, 'photo-jpg');
    expect(await codeOf(up.status(BOB, 'photo-jpg'))).toBe('NO_SESSION');
    expect((await up.status(ALICE, 'photo-jpg')).manifest.fingerprint).toBe('fp-alice');
  });

  it('enforces the maximum size from .env before writing anything', async () => {
    process.env.MULTIPART_UPLOAD_MAX_FILE_BYTES = String(2 * MIB);
    const up = uploaderWith();
    const err = await up.begin(ALICE, { fileName: 'big.bin', totalBytes: 2 * MIB + 1, fingerprint: 'fp' }).catch((e) => e);
    expect(err.code).toBe('FILE_TOO_LARGE');
    expect(err.status).toBe(413);
    expect(err.details).toEqual({ maxFileBytes: 2 * MIB });
    expect(await readdir(root)).toEqual([]); // nothing created
    // Exactly at the limit is accepted.
    expect((await up.begin(ALICE, { fileName: 'ok.bin', totalBytes: 2 * MIB, fingerprint: 'fp' })).created).toBe(true);
  });

  it('refuses metadata over the cap and non-object metadata', async () => {
    const up = uploaderWith({ maxMetadataBytes: 64 });
    expect(await codeOf(up.begin(ALICE, { fileName: 'a.bin', totalBytes: 10, fingerprint: 'fp', metadata: { note: 'x'.repeat(100) } }))).toBe('METADATA_TOO_LARGE');
    expect(await codeOf(up.begin(ALICE, { fileName: 'a.bin', totalBytes: 10, fingerprint: 'fp', metadata: [] as never }))).toBe('INVALID_REQUEST');
  });

  it('freezes the part size per upload: changing it mid-upload does not break the resume', async () => {
    // MUTATION: read partBytes from config in putPart -> every part after the
    // change is rejected with PART_LENGTH_MISMATCH.
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    await up.begin(ALICE, { fileName: 'f.bin', totalBytes: SIZE, fingerprint: fingerprintOf(bytes, 'f.bin') });
    process.env.MULTIPART_UPLOAD_PART_BYTES = String(2 * MIB);
    await sendParts(up, ALICE, 'f-bin', bytes, 'f.bin', [1, 2, 3, 4]);
    const done = await up.complete(ALICE, 'f-bin');
    expect(done.sha256).toBe(sha256(bytes));
  });
});

describe('parts', () => {
  it('is idempotent: re-sending a stored part succeeds as already present', async () => {
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    await up.begin(ALICE, { fileName: 'f.bin', totalBytes: SIZE, fingerprint: fingerprintOf(bytes, 'f.bin') });
    const part = { uploadId: 'f-bin', index: 1, bytes: partOf(bytes, 1, MIB), fingerprint: fingerprintOf(bytes, 'f.bin') };
    expect((await up.putPart(ALICE, part)).alreadyPresent).toBe(false);
    expect((await up.putPart(ALICE, part)).alreadyPresent).toBe(true);
  });

  it('checks the fingerprint, the index and the exact length on every part', async () => {
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    const fp = fingerprintOf(bytes, 'f.bin');
    await up.begin(ALICE, { fileName: 'f.bin', totalBytes: SIZE, fingerprint: fp });
    expect(await codeOf(up.putPart(ALICE, { uploadId: 'f-bin', index: 1, bytes: partOf(bytes, 1, MIB), fingerprint: 'other' }))).toBe('FINGERPRINT_MISMATCH');
    expect(await codeOf(up.putPart(ALICE, { uploadId: 'f-bin', index: 5, bytes: partOf(bytes, 1, MIB), fingerprint: fp }))).toBe('PART_OUT_OF_RANGE');
    expect(await codeOf(up.putPart(ALICE, { uploadId: 'f-bin', index: 1, bytes: partOf(bytes, 1, MIB).subarray(1), fingerprint: fp }))).toBe('PART_LENGTH_MISMATCH');
    // The short final part must be exactly its remainder.
    expect(await codeOf(up.putPart(ALICE, { uploadId: 'f-bin', index: 4, bytes: partOf(bytes, 1, MIB), fingerprint: fp }))).toBe('PART_LENGTH_MISMATCH');
    expect(await codeOf(up.putPart(BOB, { uploadId: 'f-bin', index: 1, bytes: partOf(bytes, 1, MIB), fingerprint: fp }))).toBe('NO_SESSION');
  });

  it('lets exactly one of several concurrent writes of one part win, with correct bytes', async () => {
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    const fp = fingerprintOf(bytes, 'f.bin');
    await up.begin(ALICE, { fileName: 'f.bin', totalBytes: SIZE, fingerprint: fp });
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => codeOf(up.putPart(ALICE, { uploadId: 'f-bin', index: 2, bytes: partOf(bytes, 2, MIB), fingerprint: fp }))),
    );
    // Each attempt either succeeded or was told to retry — never anything else.
    expect(outcomes.every((o) => o === 'resolved' || o === 'PART_IN_FLIGHT')).toBe(true);
    expect(outcomes).toContain('resolved');
    const stored = await readFile(join(root, partKey(namespaceKeyFor(ALICE.namespace), 'f-bin', 2)));
    expect(sha256(new Uint8Array(stored))).toBe(sha256(partOf(bytes, 2, MIB)));
  });

  it('counts a torn (short) part as missing, and a re-send repairs it', async () => {
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    const fp = fingerprintOf(bytes, 'f.bin');
    await up.begin(ALICE, { fileName: 'f.bin', totalBytes: SIZE, fingerprint: fp });
    await sendParts(up, ALICE, 'f-bin', bytes, 'f.bin', [1, 2, 3, 4]);
    // Simulate a write that died half-way.
    await writeFile(join(root, partKey(namespaceKeyFor(ALICE.namespace), 'f-bin', 3)), partOf(bytes, 3, MIB).subarray(0, 1000));
    expect((await up.status(ALICE, 'f-bin')).missingParts).toEqual([3]);
    expect(await codeOf(up.complete(ALICE, 'f-bin'))).toBe('INCOMPLETE');
    await sendParts(up, ALICE, 'f-bin', bytes, 'f.bin', [3]);
    expect((await up.complete(ALICE, 'f-bin')).sha256).toBe(sha256(bytes));
  });

  it('refuses a part on another instance', async () => {
    const up = uploaderWith();
    await up.begin(ALICE, { fileName: 'f.bin', totalBytes: SIZE, fingerprint: 'fp' });
    process.env.MULTIPART_UPLOAD_INSTANCE_ID = 'node-b';
    expect(await codeOf(up.putPart(ALICE, { uploadId: 'f-bin', index: 1, bytes: new Uint8Array(MIB), fingerprint: 'fp' }))).toBe('WRONG_INSTANCE');
  });
});

describe('complete', () => {
  async function fullUpload(up: Uploader, ctx: { namespace: string }, bytes: Uint8Array<ArrayBuffer>, name: string, metadata = {}) {
    const begun = await up.begin(ctx, { fileName: name, totalBytes: bytes.byteLength, fingerprint: fingerprintOf(bytes, name), metadata });
    const id = begun.session.manifest.uploadId;
    await sendParts(up, ctx, id, bytes, name, Array.from({ length: partCountFor(bytes.byteLength, MIB) }, (_, i) => i + 1));
    return id;
  }

  it('stores the exact bytes at a per-namespace content address and removes the session', async () => {
    const seen: unknown[] = [];
    const up = uploaderWith({ onComplete: (input) => (seen.push(input.metadata), { id: 42 }) });
    const bytes = patternBytes(SIZE);
    const id = await fullUpload(up, ALICE, bytes, 'Mix.WAV', { title: 'Mix' });
    const done = await up.complete(ALICE, id);

    const ns = namespaceKeyFor(ALICE.namespace);
    expect(done.key).toBe(`files/${ns}/${sha256(bytes)}.wav`);
    expect(sha256(new Uint8Array(await readFile(join(root, done.key))))).toBe(sha256(bytes));
    expect(done).toMatchObject({ size: SIZE, deduplicated: false, result: { id: 42 } });
    expect(seen).toEqual([{ title: 'Mix' }]); // metadata frozen at begin
    expect(await readdir(join(root, sessionKey(ns, '')).replace(/[\\/]$/, ''))).toEqual([]);
  });

  it('deduplicates identical bytes within a namespace, not across namespaces', async () => {
    // Across namespaces would tell one user, via `deduplicated`, that another
    // user already uploaded the same file.
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    const first = await up.complete(ALICE, await fullUpload(up, ALICE, bytes, 'a.bin'));
    const second = await up.complete(ALICE, await fullUpload(up, ALICE, bytes, 'copy-of-a.bin'));
    const other = await up.complete(BOB, await fullUpload(up, BOB, bytes, 'a.bin'));
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.key).toBe(first.key);
    expect(other.deduplicated).toBe(false);
    expect(other.key).not.toBe(first.key);
  });

  it('keeps the parts when validateHead rejects the file', async () => {
    let calls = 0;
    const up = uploaderWith({
      validateHead: (head) => {
        calls += 1;
        if (head[0] !== 0x49) throw new Error('Not an ID3 tagged MP3');
      },
    });
    const bytes = patternBytes(SIZE);
    const id = await fullUpload(up, ALICE, bytes, 'f.mp3');
    const err = await up.complete(ALICE, id).catch((e) => e);
    expect(err.code).toBe('REJECTED');
    expect(err.message).toBe('Not an ID3 tagged MP3');
    expect(calls).toBe(1);
    expect((await up.status(ALICE, id)).complete).toBe(true); // parts kept
  });

  it('removes the new file but keeps the parts when onComplete throws, so a retry works', async () => {
    let fail = true;
    const up = uploaderWith({
      onComplete: () => {
        if (fail) throw new Error('database down');
        return 'ok';
      },
    });
    const bytes = patternBytes(SIZE);
    const id = await fullUpload(up, ALICE, bytes, 'f.bin');
    await expect(up.complete(ALICE, id)).rejects.toThrow('database down');
    expect(await readdir(join(root, 'files', namespaceKeyFor(ALICE.namespace))).catch(() => [])).toEqual([]);
    fail = false;
    expect((await up.complete(ALICE, id)).result).toBe('ok');
  });

  it('reports which parts are missing', async () => {
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    await up.begin(ALICE, { fileName: 'f.bin', totalBytes: SIZE, fingerprint: fingerprintOf(bytes, 'f.bin') });
    await sendParts(up, ALICE, 'f-bin', bytes, 'f.bin', [1, 3]);
    const err = await up.complete(ALICE, 'f-bin').catch((e) => e);
    expect(err.code).toBe('INCOMPLETE');
    expect(err.details).toEqual({ missingParts: [2, 4] });
  });

  it('lets only one of two concurrent completes assemble', async () => {
    const up = uploaderWith();
    const bytes = patternBytes(SIZE);
    const id = await fullUpload(up, ALICE, bytes, 'f.bin');
    const outcomes = await Promise.all([codeOf(up.complete(ALICE, id)), codeOf(up.complete(ALICE, id))]);
    expect(outcomes.filter((o) => o === 'resolved')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'COMPLETE_IN_PROGRESS' || o === 'NO_SESSION')).toHaveLength(1);
  });

  it('takes over a lock abandoned by a crashed process', async () => {
    const up = uploaderWith({ lockStaleMs: 60_000 });
    const bytes = patternBytes(SIZE);
    const id = await fullUpload(up, ALICE, bytes, 'f.bin');
    const lock = join(root, lockKey(namespaceKeyFor(ALICE.namespace), id));
    await writeFile(lock, 'crashed');
    expect(await codeOf(up.complete(ALICE, id))).toBe('COMPLETE_IN_PROGRESS'); // fresh lock respected
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, old, old);
    expect((await up.complete(ALICE, id)).sha256).toBe(sha256(bytes)); // stale lock taken over
  });

  it('refuses to discard while a complete holds the lock', async () => {
    const up = uploaderWith();
    const id = await fullUpload(up, ALICE, patternBytes(SIZE), 'f.bin');
    await writeFile(join(root, lockKey(namespaceKeyFor(ALICE.namespace), id)), 'busy');
    expect(await codeOf(up.discard(ALICE, id))).toBe('COMPLETE_IN_PROGRESS');
  });

  it('rejects a complete for an upload that does not exist, without creating anything', async () => {
    const up = uploaderWith();
    expect(await codeOf(up.complete(ALICE, 'nothing-here'))).toBe('NO_SESSION');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('sweep', () => {
  async function age(dir: string, ms: number) {
    const when = new Date(Date.now() - ms);
    for (const entry of await readdir(dir)) await utimes(join(dir, entry), when, when);
    await utimes(dir, when, when);
  }

  it('removes abandoned uploads, keeps fresh ones, and measures age by the NEWEST file', async () => {
    process.env.MULTIPART_UPLOAD_PART_TTL_HOURS = '1';
    const up = uploaderWith();
    const ns = namespaceKeyFor(ALICE.namespace);
    const bytes = patternBytes(SIZE);
    for (const name of ['old.bin', 'fresh.bin', 'paused.bin']) {
      await up.begin(ALICE, { fileName: name, totalBytes: SIZE, fingerprint: fingerprintOf(bytes, name) });
    }
    await age(join(root, sessionKey(ns, 'old-bin')), 2 * 3_600_000);
    // Paused overnight: old manifest, but a part sent just now.
    await age(join(root, sessionKey(ns, 'paused-bin')), 2 * 3_600_000);
    await sendParts(up, ALICE, 'paused-bin', bytes, 'paused.bin', [1]);

    const result = await up.sweep();
    expect(result.deleted).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
    // MUTATION: use the manifest's age -> 'paused-bin' is reaped mid-flight.
    expect((await up.list(ALICE)).map((s) => s.manifest.uploadId).sort()).toEqual(['fresh-bin', 'paused-bin']);
  });
});
