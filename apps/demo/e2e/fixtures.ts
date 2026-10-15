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
// File signatures ("magic numbers"), written over the first bytes so the
// server's content check sees a real format.
const PDF_SIGNATURE = Array.from('%PDF-1.7\n', (c) => c.charCodeAt(0));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXE_SIGNATURE = [0x4d, 0x5a, 0x90, 0x00]; // "MZ": a Windows executable
// An MP4 "ftyp" box: size, "ftyp", major brand "isom". The demo accepts video/*,
// and the server checks content, so the general-purpose fixtures are real MP4s.
const MP4_SIGNATURE = [0x00, 0x00, 0x00, 0x20, ...Array.from('ftypisom', (c) => c.charCodeAt(0))];

interface Fixture {
  readonly name: string;
  readonly size: number;
  readonly dir: string;
  readonly signature?: readonly number[];
  /**
   * Written as its first 128 KB, then EXTENDED to `size` (zero-filled by the
   * filesystem). For a file that must only be large — one the server refuses
   * before reading — without generating hundreds of MB of bytes per run.
   */
  readonly extendTo?: true;
}

export const FIXTURES = {
  small: { name: 'small-clip.mp4', size: 6 * MIB + 123, dir: '', signature: MP4_SIGNATURE },
  resumable: { name: 'long-recording.mp4', size: 30 * MIB + 777, dir: '', signature: MP4_SIGNATURE }, // 16 parts at 2 MiB
  // 1 MB over the demo's 500 MB limit (app/upload-settings.ts).
  tooBig: { name: 'too-big.mp4', size: 501 * MIB, dir: '', signature: MP4_SIGNATURE, extendTo: true },
  retried: { name: 'flaky-network.mp4', size: 8 * MIB + 5, dir: '', signature: MP4_SIGNATURE },
  discarded: { name: 'changed-my-mind.mp4', size: 20 * MIB, dir: '', signature: MP4_SIGNATURE },
  // Same NAME as `clash`, different bytes — a second file the user happens to
  // have named identically. Kept in a subdirectory so both exist on disk.
  clash: { name: 'report.pdf', size: 10 * MIB, dir: '', signature: PDF_SIGNATURE },
  clashOther: { name: 'report.pdf', size: 10 * MIB, dir: 'other', signature: PDF_SIGNATURE },
  // allowedTypes (the demo's, app/upload-settings.ts): a genuine image, an
  // executable renamed to .png, and a type that is not allowed at all.
  photo: { name: 'holiday-photo.png', size: 3 * MIB + 11, dir: '', signature: PNG_SIGNATURE },
  disguisedExe: { name: 'holiday.png', size: 2 * MIB + 7, dir: '', signature: EXE_SIGNATURE },
  notes: { name: 'notes.txt', size: 2048, dir: '' },
} as const satisfies Record<string, Fixture>;

export type FixtureKey = keyof typeof FIXTURES;

/**
 * The bytes written for a fixture: offset-dependent pattern, signature first.
 * For an `extendTo` fixture, only its first 128 KB; the file is then extended.
 */
export function fixtureBytes(key: FixtureKey, seed: number): Uint8Array {
  const fixture: Fixture = FIXTURES[key];
  const bytes = patternBytes(fixture.extendTo ? Math.min(fixture.size, 128 * 1024) : fixture.size, seed);
  if (fixture.signature) bytes.set(fixture.signature);
  return bytes;
}

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
