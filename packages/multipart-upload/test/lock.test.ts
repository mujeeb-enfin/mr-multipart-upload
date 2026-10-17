// ---------------------------------------------------------------------------
// lock.test.ts — the complete lock under contention (filesystem)
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. Exactly one request may finish an upload. A lock left by
// a dead process is taken over; two requests taking over the SAME abandoned
// lock must not both win (the old delete-then-create takeover let the second
// taker delete the first one's fresh lock). A holder that was taken over must
// find out before acting, and releasing must never remove a newer holder's
// lock. The cloud backends run the same contract in cloud/proxy-scenarios.
// ---------------------------------------------------------------------------

import { readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UploadError } from '../src/core/errors.js';
import { lockGenerationKey, sessionKey } from '../src/core/layout.js';
import { acquireLock } from '../src/server/lock.js';
import type { StoreContext } from '../src/server/store.js';
import type { StorageAdapter } from '../src/storage/adapter.js';
import { FsStorage } from '../src/storage/fs-storage.js';
import { tempRoot } from './helpers.js';

let root: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir: root, cleanup } = await tempRoot());
});
afterEach(async () => {
  await cleanup();
});

const NS = 'ns-lock';
const ID = 'a'.repeat(64);
const store = (storage: StorageAdapter) => ({ storage, namespaceKey: NS }) as unknown as StoreContext;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'acquired';
  } catch (err) {
    return err instanceof UploadError ? err.code : `unexpected: ${String(err)}`;
  }
}

/**
 * FsStorage that forces the worst interleaving of two takers: both read the
 * abandoned lock, then the FIRST finishes acquiring, and only then does the
 * second go on — so whatever the second does lands after the first already
 * holds a lock.
 */
function twoTakersInTurn(): StorageAdapter {
  const inner = new FsStorage(root);
  let readers = 0;
  let bothRead!: () => void;
  const bothHaveRead = new Promise<void>((resolve) => (bothRead = resolve));
  let firstDone!: () => void;
  const firstHasActed = new Promise<void>((resolve) => (firstDone = resolve));
  return Object.assign(Object.create(FsStorage.prototype), inner, {
    async stat(key: string) {
      const info = await inner.stat(key);
      if (!key.includes('completing')) return info;
      readers += 1;
      const turn = readers;
      if (turn === 2) bothRead();
      await bothHaveRead;
      if (turn === 2) await firstHasActed;
      return info;
    },
    async createExclusive(key: string, data: Uint8Array | string) {
      const outcome = await inner.createExclusive(key, data);
      if (key.includes('completing')) firstDone();
      return outcome;
    },
  });
}

describe('the complete lock', () => {
  it('lets exactly one of two requests take over the same abandoned lock', async () => {
    // Both read the abandoned lock; the second acts only after the first has
    // taken it — the interleaving that let the old takeover give BOTH the lock
    // (the second deleted the first's fresh lock, then created its own).
    // MUTATION: take over by remove(newest) + createExclusive(newest) (one name,
    // as before) -> both acquire.
    const fs = new FsStorage(root);
    await fs.createExclusive(lockGenerationKey(NS, ID, 1), 'crashed');
    const contended = store(twoTakersInTurn());
    const outcomes = await Promise.all([codeOf(acquireLock(contended, ID, -1)), codeOf(acquireLock(contended, ID, -1))]);
    expect(outcomes.sort()).toEqual(['COMPLETE_IN_PROGRESS', 'acquired']);
    // The winner holds generation 2; the abandoned generation 1 is untouched until released.
    expect((await readdir(join(root, sessionKey(NS, ID)))).sort()).toEqual(['completing.1.lock', 'completing.2.lock']);
  });

  it('a holder that was taken over finds out before acting; its release leaves the new holder alone', async () => {
    // MUTATION: make confirm() always pass -> the stalled holder would go on to
    // commit or run onComplete a second time.
    const ctx = store(new FsStorage(root));
    const stalled = await acquireLock(ctx, ID, 60_000);
    const taker = await acquireLock(ctx, ID, -1); // the stalled holder's lock looks abandoned
    expect(taker.generation).toBe(stalled.generation + 1);
    expect(await codeOf(stalled.confirm())).toBe('COMPLETE_IN_PROGRESS');
    await stalled.release();
    await expect(taker.confirm()).resolves.toBeUndefined();
    expect(await codeOf(acquireLock(ctx, ID, 60_000))).toBe('COMPLETE_IN_PROGRESS'); // still held
    await taker.release();
    expect(await readdir(join(root, sessionKey(NS, ID)))).toEqual([]);
    expect((await acquireLock(ctx, ID, 60_000)).generation).toBe(1);
  });

  it('refreshing a lock that was taken over fails, and never brings the lock back', async () => {
    // Found by the flow test: a stalled holder refreshed BEFORE confirming, and
    // the rewrite recreated its lock in a session the taker had already finished
    // and deleted — after which the stale holder passed every check.
    // MUTATION: write first, confirm after (or not at all) -> the lock file reappears.
    const ctx = store(new FsStorage(root));
    const stalled = await acquireLock(ctx, ID, 60_000);
    const taker = await acquireLock(ctx, ID, -1);
    await taker.release(); // the taker finished; its session is gone
    await ctx.storage.removeTree(sessionKey(NS, ID));
    expect(await codeOf(stalled.refresh())).toBe('COMPLETE_IN_PROGRESS');
    expect(await ctx.storage.stat(lockGenerationKey(NS, ID, stalled.generation))).toBeNull();
  });

  it('a fresh lock is respected, and refresh keeps a long-running holder from looking abandoned', async () => {
    const ctx = store(new FsStorage(root));
    const holder = await acquireLock(ctx, ID, 60_000);
    expect(await codeOf(acquireLock(ctx, ID, 60_000))).toBe('COMPLETE_IN_PROGRESS');
    // Made to look old explicitly: comparing two mtimes taken milliseconds apart
    // fails on filesystems with coarse timestamps.
    const lockPath = join(root, lockGenerationKey(NS, ID, holder.generation));
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(lockPath, old, old);
    await holder.refresh();
    // Refreshed: fresh again, so another request still sees the lock as held.
    expect(Date.now() - ((await ctx.storage.stat(lockGenerationKey(NS, ID, holder.generation)))?.modifiedMs ?? 0)).toBeLessThan(60_000);
    expect(await codeOf(acquireLock(ctx, ID, 60_000))).toBe('COMPLETE_IN_PROGRESS');
  });

  it('a holder whose generation number was reused by a later request is not fooled by it (ABA)', async () => {
    // Numbering starts over once every holder has released. A stalled holder of
    // an old generation 1 must not take a NEW request's generation 1 for its own.
    // MUTATION: confirm by number only (drop the token comparison) -> the
    // stalled holder confirms, and its release deletes the new holder's lock.
    const ctx = store(new FsStorage(root));
    const stalled = await acquireLock(ctx, ID, 60_000); // generation 1
    const taker = await acquireLock(ctx, ID, -1); // generation 2
    await taker.release();
    await ctx.storage.remove(lockGenerationKey(NS, ID, 1)); // the abandoned generation 1 is cleared too
    const fresh = await acquireLock(ctx, ID, 60_000);
    expect(fresh.generation).toBe(stalled.generation); // the number is reused
    expect(await codeOf(stalled.confirm())).toBe('COMPLETE_IN_PROGRESS');
    await stalled.release();
    await expect(fresh.confirm()).resolves.toBeUndefined(); // still held
  });

  it('release leaves a FRESH older lock alone — one an older version of the library may hold', async () => {
    // During a rolling deploy an older instance knows only `completing.lock`
    // (generation 0) and may take it while a new instance holds generation 1.
    // MUTATION: release every older generation regardless of age -> the older
    // instance's live lock is deleted.
    const fs = new FsStorage(root);
    const ctx = store(fs);
    const holder = await acquireLock(ctx, ID, 60_000);
    await fs.createExclusive(lockGenerationKey(NS, ID, 0), 'held by an older instance');
    await holder.release();
    expect(await fs.stat(lockGenerationKey(NS, ID, 0))).not.toBeNull();
    expect(await fs.stat(lockGenerationKey(NS, ID, holder.generation))).toBeNull();
    expect(await codeOf(acquireLock(ctx, ID, 60_000))).toBe('COMPLETE_IN_PROGRESS'); // and it is respected
  });
});
