// ---------------------------------------------------------------------------
// lock.ts — the single-flight lock `complete` holds and `discard` takes
// ---------------------------------------------------------------------------
//
// A lock is a file (an object, in the cloud), so a process that dies while
// holding it leaves it behind. One older than `staleMs` is taken over.
//
// GENERATIONS, NOT ONE NAME. Taking over by deleting the stale lock and
// creating it again is two steps, and two takers can interleave: A deletes and
// creates; B, which saw the same stale lock, deletes A's FRESH lock and creates
// its own — and both believe they hold it. Here each lock is a generation,
// `completing.<n>.lock`, and a takeover creates n+1 with the one primitive every
// backend makes atomic: exclusive create. Two takers race for the same n+1 and
// exactly one gets it. Nothing is ever deleted to take a lock.
//
// SLOW IS NOT DEAD. A holder refreshes its lock between long steps, so a slow
// complete is not taken for an abandoned one, and confirms it still holds the
// newest generation right before each irreversible step: a holder that WAS
// taken over (it stalled past `staleMs`) stops instead of acting twice.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

import { UploadError } from '../core/errors.js';
import { lockGenerationKey, parseLockFileName, sessionKey } from '../core/layout.js';
import type { StoreContext } from './store.js';

export const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

export interface HeldLock {
  readonly generation: number;
  /**
   * Confirm the lock is still held, then rewrite it, so a long step is not
   * mistaken for an abandoned complete. Confirming FIRST matters: rewriting a
   * lock that was taken over — its session possibly already finished and
   * deleted — would recreate it and make the stale holder look current again.
   */
  refresh(): Promise<void>;
  /** Throw COMPLETE_IN_PROGRESS when another request has taken the lock over. */
  confirm(): Promise<void>;
  /**
   * Remove this holder's lock — only while it still carries this holder's
   * token — and older generations once they are stale. Absent is success.
   */
  release(): Promise<void>;
}

/** Lock generations present for an upload, newest first. */
async function generationsOf(store: StoreContext, uploadId: string): Promise<number[]> {
  const names = await store.storage.list(sessionKey(store.namespaceKey, uploadId));
  return names
    .map(parseLockFileName)
    .filter((n): n is number => n !== null)
    .sort((a, b) => b - a);
}

/**
 * The token a lock file holds, or null when it cannot be read — absent, or
 * removed between the look and the read. Failing closed is the safe reading: a
 * holder that cannot see its own token stops (COMPLETE_IN_PROGRESS) instead of
 * acting, and a raw storage error never escapes as a 500.
 */
async function tokenAt(store: StoreContext, key: string): Promise<string | null> {
  try {
    if (!(await store.storage.stat(key))) return null;
    return new TextDecoder().decode(await store.storage.readHead(key, 128)).trim();
  } catch {
    return null;
  }
}

function busy(): UploadError {
  return new UploadError('COMPLETE_IN_PROGRESS', 'This upload is already being finalised.');
}

function held(store: StoreContext, uploadId: string, generation: number, token: string, staleMs: number): HeldLock {
  const keyOf = (n: number) => lockGenerationKey(store.namespaceKey, uploadId, n);
  const confirm = async () => {
    // The newest generation must be this one AND carry this holder's token.
    // The number alone is not enough: once every holder released, numbering
    // starts over, and a stalled holder of an old generation 1 would otherwise
    // take a NEW request's generation 1 for its own (ABA).
    const [newest] = await generationsOf(store, uploadId);
    if (newest !== generation || (await tokenAt(store, keyOf(generation))) !== token) {
      throw new UploadError('COMPLETE_IN_PROGRESS', 'Another request took over finishing this upload.');
    }
  };
  return {
    generation,
    async refresh() {
      await confirm();
      // A backend without `write` (a custom adapter) cannot refresh; its holder
      // relies on `staleMs` exceeding the longest complete.
      await store.storage.write?.(keyOf(generation), token);
    },
    confirm,
    async release() {
      const generations = await generationsOf(store, uploadId).catch(() => [] as number[]);
      for (const n of generations) {
        if (n > generation) continue;
        const key = keyOf(n);
        if (n === generation) {
          if ((await tokenAt(store, key).catch(() => null)) === token) await store.storage.remove(key);
          continue;
        }
        // An older generation is a holder this one took over — or, during a
        // rolling deploy, a lock an older version just wrote: only a stale one goes.
        const info = await store.storage.stat(key).catch(() => null);
        if (info && Date.now() - info.modifiedMs > staleMs) await store.storage.remove(key);
      }
    },
  };
}

/** Take the lock, or throw COMPLETE_IN_PROGRESS while another request holds it. */
export async function acquireLock(store: StoreContext, uploadId: string, staleMs: number): Promise<HeldLock> {
  const token = `${randomUUID()} ${new Date().toISOString()}`;
  // Two looks at most: a lock released between listing and reading it is
  // simply looked for again.
  for (let look = 0; look < 2; look += 1) {
    const generations = await generationsOf(store, uploadId);
    let next = 1;
    let vanished = false;
    // Busy while ANY generation is fresh, not only the newest: an older version
    // of this library (one name, `completing.lock`) may hold one alongside.
    for (const n of generations) {
      const info = await store.storage.stat(lockGenerationKey(store.namespaceKey, uploadId, n));
      if (!info) {
        vanished = true;
        continue;
      }
      if (Date.now() - info.modifiedMs <= staleMs) throw busy();
    }
    if (vanished && look === 0) continue;
    if (generations.length > 0) next = (generations[0] as number) + 1;
    const outcome = await store.storage.createExclusive(lockGenerationKey(store.namespaceKey, uploadId, next), token);
    if (outcome === 'created') return held(store, uploadId, next, token, staleMs);
    // Another request created that generation first: it holds the lock.
    throw busy();
  }
  throw busy();
}

/**
 * Discard under the `complete` lock. Deleting the parts while `complete` is
 * using them would turn a successful finish into a half-assembled failure, so
 * discard TAKES the lock rather than only looking for it: a complete starting
 * between a look and the delete would otherwise race it. `remove` deletes the
 * session (and, for cloud storage, the provider's side) — the lock with it.
 */
export async function discardUnderLock(store: StoreContext, uploadId: string, staleMs: number, remove: () => Promise<void>): Promise<void> {
  let lock: HeldLock;
  try {
    lock = await acquireLock(store, uploadId, staleMs);
  } catch (err) {
    if (err instanceof UploadError && err.code === 'COMPLETE_IN_PROGRESS') {
      throw new UploadError('COMPLETE_IN_PROGRESS', 'This upload is being finalised and cannot be discarded now.');
    }
    throw err;
  }
  try {
    // Confirmed like every other irreversible step: two takeovers racing a
    // restart of the numbering can both create a generation, and only the one
    // that confirms may delete anything.
    await lock.confirm().catch(() => {
      throw new UploadError('COMPLETE_IN_PROGRESS', 'This upload is being finalised and cannot be discarded now.');
    });
    await remove();
  } catch (err) {
    // The session survives a failed discard; its lock must not block it.
    await lock.release().catch(() => undefined);
    throw err;
  }
}
