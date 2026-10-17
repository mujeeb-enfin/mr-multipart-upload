// ---------------------------------------------------------------------------
// uploader-concurrency.test.ts — local storage under contention
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. Concurrent requests on one upload, or on one storage key,
// must never both act: discard holds the lock it checks; a complete that
// stalled past lockStaleMs and was taken over neither publishes again nor
// deletes what the request that took over is using; two uploads onto one
// custom destination store exactly one file and refuse the other. Each race is
// forced with a gate at the exact step, not hoped for.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { partCountFor } from '../src/core/arithmetic.js';
import { UploadError } from '../src/core/errors.js';
import { createUploader, type Uploader, type UploaderOptions } from '../src/server/uploader.js';
import type { StorageAdapter } from '../src/storage/adapter.js';
import { FsStorage } from '../src/storage/fs-storage.js';
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
const SIZE = 3 * MIB + 12_345;

const uploaderWith = (extra: UploaderOptions = {}): Uploader => createUploader({ dir: root, sweepOnBegin: false, ...extra });

async function fullUpload(up: Uploader, ctx: { namespace: string }, bytes: Uint8Array<ArrayBuffer>, name: string): Promise<string> {
  const fingerprint = `${bytes.byteLength}-1-${name.length}`;
  const begun = await up.begin(ctx, { fileName: name, totalBytes: bytes.byteLength, fingerprint });
  const id = begun.session.manifest.uploadId;
  for (let index = 1; index <= partCountFor(bytes.byteLength, MIB); index += 1) {
    await up.putPart(ctx, { uploadId: id, index, bytes: partOf(bytes, index, MIB), fingerprint });
  }
  return id;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof UploadError ? err.code : `non-upload-error: ${String(err)}`;
  }
}

/** A gate: `reached` resolves when the guarded step is hit, `open()` lets it continue. */
function gate() {
  let open!: () => void;
  let hit!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (hit = resolve));
  return { open, reached, hold: async () => (hit(), opened) };
}

/** FsStorage with some methods replaced. */
function storageWith(overrides: Partial<Record<keyof FsStorage, unknown>>): { storage: StorageAdapter; inner: FsStorage } {
  const inner = new FsStorage(root);
  return { storage: Object.assign(Object.create(FsStorage.prototype), inner, overrides) as StorageAdapter, inner };
}

describe('local storage under contention', () => {
  it('holds the lock while it discards, so a complete starting meanwhile is refused', async () => {
    // A discard that only LOOKED for the lock let a complete start between the
    // look and the delete: one deleted the parts the other was assembling.
    // MUTATION: replace discardUnderLock's acquireLock with a stat check -> the
    // complete runs and finishes, not COMPLETE_IN_PROGRESS.
    const deleting = gate();
    let gated = false;
    const inner = new FsStorage(root);
    const { storage } = storageWith({
      async removeTree(key: string) {
        if (!gated) {
          gated = true; // only discard's delete is held; a complete that wrongly ran must finish
          await deleting.hold();
        }
        return inner.removeTree(key);
      },
    });
    const up = uploaderWith({ storage });
    const id = await fullUpload(up, ALICE, patternBytes(SIZE), 'f.bin');

    const discarding = up.discard(ALICE, id);
    await deleting.reached;
    expect(await codeOf(up.complete(ALICE, id))).toBe('COMPLETE_IN_PROGRESS');
    deleting.open();
    await discarding;
    expect(await codeOf(up.status(ALICE, id))).toBe('NO_SESSION');
  });

  it('a complete that stalls past lockStaleMs before publishing is taken over and neither publishes nor runs onComplete again', async () => {
    // MUTATION: drop the lock check (refresh) before publishing -> the stalled
    // holder goes on to publish instead of stopping (here it then fails on the
    // staging state the taker changed; with another timing it would publish and
    // run onComplete a second time).
    const assembling = gate();
    let held = false;
    const inner = new FsStorage(root);
    const { storage } = storageWith({
      async assemble(partKeys: readonly string[], destKey: string) {
        const assembled = await inner.assemble(partKeys, destKey);
        if (!held) {
          held = true; // only the FIRST complete stalls here
          await assembling.hold();
        }
        return assembled;
      },
    });
    const calls: string[] = [];
    const onComplete = ({ file }: { file: { sha256: string } }) => void calls.push(file.sha256);
    const stalledUploader = uploaderWith({ storage, onComplete });
    const takerUploader = uploaderWith({ storage, onComplete, lockStaleMs: -1 }); // sees any lock as abandoned
    const bytes = patternBytes(SIZE);
    const id = await fullUpload(stalledUploader, ALICE, bytes, 'f.bin');

    const stalled = codeOf(stalledUploader.complete(ALICE, id));
    await assembling.reached;
    const taken = await takerUploader.complete(ALICE, id);
    assembling.open();
    expect(await stalled).toBe('COMPLETE_IN_PROGRESS');
    expect(calls).toEqual([sha256(bytes)]);
    expect(sha256(new Uint8Array(await readFile(join(root, taken.key))))).toBe(sha256(bytes));
  });

  it('a complete that stalls INSIDE onComplete and is taken over leaves the parts of the taker alone', async () => {
    // The stalled holder resumes after the taker has started assembling; its
    // cleanup must see the lock is no longer its own and leave the parts.
    // MUTATION: replace stillHeld(lock) before the cleanup with `true` -> the
    // stalled holder deletes the session and the taker's assembly fails.
    const inOnComplete = gate();
    const takerAssembling = gate();
    let assemblies = 0;
    const inner = new FsStorage(root);
    const { storage } = storageWith({
      async assemble(partKeys: readonly string[], destKey: string) {
        assemblies += 1;
        if (assemblies === 2) await takerAssembling.hold(); // the taker, about to read the parts
        return inner.assemble(partKeys, destKey);
      },
    });
    let first = true;
    const onComplete = async () => {
      if (first) {
        first = false;
        await inOnComplete.hold(); // the first complete stalls here
      }
      return 'recorded';
    };
    const stalledUploader = uploaderWith({ storage, onComplete });
    const takerUploader = uploaderWith({ storage, onComplete, lockStaleMs: -1 });
    const bytes = patternBytes(SIZE);
    const id = await fullUpload(stalledUploader, ALICE, bytes, 'f.bin');

    const stalled = stalledUploader.complete(ALICE, id);
    await inOnComplete.reached;
    const taken = takerUploader.complete(ALICE, id);
    await takerAssembling.reached;
    inOnComplete.open(); // the stalled holder finishes onComplete and cleans up — or must not
    expect(await stalled).toMatchObject({ result: 'recorded' });
    takerAssembling.open();
    expect(await taken).toMatchObject({ result: 'recorded', deduplicated: true });
    expect(sha256(new Uint8Array(await readFile(join(root, (await taken).key))))).toBe(sha256(bytes));
  });

  it('two completes onto one custom destination store exactly one file; the other is refused', async () => {
    // The look ("is the key taken?") and the publish used to be two steps; both
    // completes could pass the look, and the second rename silently replaced
    // the first file. promoteExclusive makes it one atomic step, and a taken
    // custom key is refused (DESTINATION_EXISTS) — the loser is never handed
    // the winner's bytes as its own.
    // MUTATION: implement promoteExclusive with rename (replacing) -> both
    // resolve and the stored bytes are the second upload's.
    const bothReady = gate();
    let waiting = 0;
    const inner = new FsStorage(root);
    const { storage } = storageWith({
      async promoteExclusive(from: string, to: string) {
        waiting += 1;
        if (waiting === 2) bothReady.open();
        await (waiting === 2 ? Promise.resolve() : bothReady.hold());
        return inner.promoteExclusive(from, to);
      },
    });
    const up = uploaderWith({ storage, destination: ({ extension }) => `shared/one.${extension}` });
    const first = patternBytes(SIZE, 1);
    const second = patternBytes(SIZE, 2);
    const idA = await fullUpload(up, ALICE, first, 'a.bin');
    const idB = await fullUpload(up, BOB, second, 'b.bin');
    const outcomes = await Promise.all([codeOf(up.complete(ALICE, idA)), codeOf(up.complete(BOB, idB))]);
    expect([...outcomes].sort()).toEqual(['DESTINATION_EXISTS', 'resolved']);
    const winnerBytes = outcomes[0] === 'resolved' ? first : second;
    expect(sha256(new Uint8Array(await readFile(join(root, 'shared/one.bin'))))).toBe(sha256(winnerBytes));
    // The refused upload keeps its parts: it can be discarded, or finished elsewhere.
    const [loserCtx, loserId] = outcomes[0] === 'resolved' ? [BOB, idB] : [ALICE, idA];
    expect((await up.status(loserCtx, loserId)).missingParts).toEqual([]);
  });
});
