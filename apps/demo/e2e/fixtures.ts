import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_DIR = join(process.cwd(), 'e2e', '.fixtures');
export const MIB = 1024 * 1024;

/**
 * Real files on disk, not in-memory buffers. Playwright stamps an in-memory file
 * with the CURRENT time as lastModified, so picking it twice gives two different
 * fingerprints and the server correctly refuses to resume. A file on disk keeps
 * its mtime, exactly like a user re-picking the same file.
 */
export const FIXTURES = {
  small: { name: 'small-clip.bin', size: 6 * MIB + 123, dir: '' },
  resumable: { name: 'long-recording.bin', size: 30 * MIB + 777, dir: '' }, // 31 parts at 1 MiB
  tooBig: { name: 'too-big.bin', size: 41 * MIB, dir: '' }, // over the 40 MiB limit
  retried: { name: 'flaky-network.bin', size: 8 * MIB + 5, dir: '' },
  discarded: { name: 'changed-my-mind.bin', size: 20 * MIB, dir: '' },
  // Same NAME as `clash`, different bytes — a second file the user happens to
  // have named identically. Kept in a subdirectory so both exist on disk.
  clash: { name: 'report.pdf', size: 10 * MIB, dir: '' },
  clashOther: { name: 'report.pdf', size: 10 * MIB, dir: 'other' },
} as const;

export type FixtureKey = keyof typeof FIXTURES;

export function fixturePath(key: FixtureKey): string {
  const fixture = FIXTURES[key];
  return join(FIXTURE_DIR, fixture.dir, fixture.name);
}

export function sha256OfFixture(key: FixtureKey): string {
  return createHash('sha256').update(readFileSync(fixturePath(key))).digest('hex');
}

/** Offset-dependent bytes, so a misplaced or missing part changes the hash. */
export function patternBytes(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
