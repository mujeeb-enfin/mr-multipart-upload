// ---------------------------------------------------------------------------
// fs-promote-exclusive.test.ts — the local no-overwrite publish
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. `promoteExclusive` publishes with a hard link, which
// refuses an existing target, then removes the staging name. Once the link
// exists the file IS stored: a staging name that cannot be removed (a Windows
// virus scanner holding it) must not turn that into a failed publish — the
// caller would then treat a stored file as missing. `unlink` is made to fail on
// demand, so the case is forced rather than hoped for.
// ---------------------------------------------------------------------------

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const unlinkControl = vi.hoisted(() => ({ failWith: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    unlink: async (path: Parameters<typeof real.unlink>[0]) => {
      if (unlinkControl.failWith) throw Object.assign(new Error(`${unlinkControl.failWith}: held`), { code: unlinkControl.failWith });
      return real.unlink(path);
    },
  };
});

const { FsStorage } = await import('../src/storage/fs-storage.js');

let root: string;

beforeEach(async () => {
  unlinkControl.failWith = null;
  root = await mkdtemp(join(tmpdir(), 'mpu-promote-'));
});

afterEach(async () => {
  unlinkControl.failWith = null;
  await rm(root, { recursive: true, force: true });
});

describe('FsStorage.promoteExclusive', () => {
  it('publishes, and removes the staging name', async () => {
    const storage = new FsStorage(root);
    await storage.write('staging.bin', 'bytes');
    expect(await storage.promoteExclusive('staging.bin', 'files/final.bin')).toBe('moved');
    expect(await readFile(join(root, 'files/final.bin'), 'utf8')).toBe('bytes');
    expect(await storage.stat('staging.bin')).toBeNull();
  });

  it('refuses an existing target and leaves it untouched', async () => {
    const storage = new FsStorage(root);
    await writeFile(join(root, 'final.bin'), 'theirs');
    await storage.write('staging.bin', 'mine');
    expect(await storage.promoteExclusive('staging.bin', 'final.bin')).toBe('exists');
    expect(await readFile(join(root, 'final.bin'), 'utf8')).toBe('theirs');
  });

  it('reports a published file as moved even when the staging name cannot be removed', async () => {
    // MUTATION: let the unlink failure propagate -> the publish rejects although
    // the file is stored, and the complete fails with the file in place.
    const storage = new FsStorage(root);
    await storage.write('staging.bin', 'bytes');
    unlinkControl.failWith = 'EBUSY';
    expect(await storage.promoteExclusive('staging.bin', 'final.bin')).toBe('moved');
    expect(await readFile(join(root, 'final.bin'), 'utf8')).toBe('bytes');
    // The staging name is still there, for the caller's cleanup or the sweep.
    expect(await storage.stat('staging.bin')).not.toBeNull();
  });
});
