// ---------------------------------------------------------------------------
// race.test.ts — a part write in flight when its upload is discarded
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. putPart checks the fingerprint against the manifest and
// THEN writes. If a discard lands between the two, the write still happens —
// and the storage layer creates missing directories — so an orphaned part from
// the discarded file is left behind.
//
// The damage comes later: a DIFFERENT file uploaded under the same name gets a
// fresh manifest, the resume scan finds the orphan with a valid size, counts it
// as received, and the browser never sends that part. The assembled file then
// contains a chunk of the old file. Silent corruption, reported as success.
//
// The race is reproduced exactly, not simulated: a storage wrapper holds one
// part write at the point between the check and the write.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, expect, it } from 'vitest';

import type { StorageAdapter } from '../src/storage/adapter.js';
import { FsStorage } from '../src/storage/fs-storage.js';
import { createUploader } from '../src/server/uploader.js';
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

/** FsStorage that can hold the next part write until released. */
function gatedStorage(dir: string) {
  const inner = new FsStorage(dir);
  let hold: { matches: (key: string) => boolean; release: Promise<void>; reached: () => void } | null = null;
  const storage: StorageAdapter = Object.assign(Object.create(FsStorage.prototype), inner, {
    async createExclusive(key: string, data: Uint8Array | string) {
      if (hold?.matches(key)) {
        const h = hold;
        hold = null;
        h.reached();
        await h.release;
      }
      return inner.createExclusive(key, data);
    },
  });
  return {
    storage,
    holdNextPartWrite(index: number) {
      let release!: () => void;
      let reached!: () => void;
      const releasePromise = new Promise<void>((r) => (release = r));
      const reachedPromise = new Promise<void>((r) => (reached = r));
      hold = {
        matches: (key) => new RegExp(`/0*${index}(\\.[0-9a-f]+)?\\.part$`).test(key),
        release: releasePromise,
        reached,
      };
      return { reached: reachedPromise, release };
    },
  };
}

const ALICE = { namespace: 'alice' };
const SIZE = 4 * MIB; // 4 full-size parts, so a full part from one file "fits" another

it('a part written after its upload was discarded can never leak into a later, different file', async () => {
  const gate = gatedStorage(root);
  const up = createUploader({ dir: root, storage: gate.storage, sweepOnBegin: false });

  const fileA = patternBytes(SIZE, 101);
  const fileB = patternBytes(SIZE, 202); // same name, same size, different content
  const fpA = 'fp-file-a';
  const fpB = 'fp-file-b';

  // File A: begin, then a part 2 write that passes the fingerprint check and is
  // held just before it reaches the disk.
  await up.begin(ALICE, { fileName: 'video.mp4', totalBytes: SIZE, fingerprint: fpA });
  const held = gate.holdNextPartWrite(2);
  const inFlight = up.putPart(ALICE, { uploadId: 'video-mp4', index: 2, bytes: partOf(fileA, 2, MIB), fingerprint: fpA });
  await held.reached;

  // The user discards A while that write is in flight, and the write then lands.
  await up.discard(ALICE, 'video-mp4');
  held.release();
  await inFlight.catch(() => undefined);

  // File B, same name. Every part the server says is missing is sent.
  const begun = await up.begin(ALICE, { fileName: 'video.mp4', totalBytes: SIZE, fingerprint: fpB });
  expect(begun.created).toBe(true);
  expect(begun.session.missingParts).toEqual([1, 2, 3, 4]);

  // Send every part EXCEPT 2, then ask the server what is missing. That resume
  // scan lists the directory, where A's orphan part 2 now sits beside B's parts.
  // MUTATION: count parts regardless of their tag -> the scan reports nothing
  // missing, `complete` proceeds, and A's part 2 is assembled into B.
  for (const index of [1, 3, 4]) {
    await up.putPart(ALICE, { uploadId: 'video-mp4', index, bytes: partOf(fileB, index, MIB), fingerprint: fpB });
  }
  expect((await up.status(ALICE, 'video-mp4')).missingParts).toEqual([2]);

  // MUTATION: name parts without the tag -> B's part 2 write finds A's orphan at
  // the same key, takes it as "already present", and keeps A's bytes.
  await up.putPart(ALICE, { uploadId: 'video-mp4', index: 2, bytes: partOf(fileB, 2, MIB), fingerprint: fpB });

  const done = await up.complete(ALICE, 'video-mp4');
  expect(done.sha256).toBe(sha256(fileB));
  expect(done.sha256).not.toBe(sha256(fileA));
});
