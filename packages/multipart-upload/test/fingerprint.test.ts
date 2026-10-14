// ---------------------------------------------------------------------------
// fingerprint.test.ts — what makes two files "the same file"
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. The fingerprint decides whether an upload RESUMES (and so
// which stored parts are reused). Two different files that share name, size and
// modification time must not share a fingerprint, or the second resumes onto the
// first's parts and a mixture of both is stored.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { FINGERPRINT_SAMPLE_BYTES, fingerprintFor } from '../src/client/fingerprint.js';
import { fileFrom, patternBytes } from './helpers.js';

const SIZE = 3 * FINGERPRINT_SAMPLE_BYTES + 99;

describe('fingerprintFor', () => {
  it('is stable for the same file, so a resume after a reload is recognised', async () => {
    const bytes = patternBytes(SIZE, 1);
    expect(await fingerprintFor(fileFrom(bytes, 'a.mp4'))).toBe(await fingerprintFor(fileFrom(bytes, 'a.mp4')));
  });

  it('DIFFERS for two files with the same name, size and mtime but different content', async () => {
    // MUTATION: drop the content hash -> both get one fingerprint, and the second
    // file silently resumes onto the first file's parts.
    const a = fileFrom(patternBytes(SIZE, 1), 'build.zip', 315_532_800_000); // a pinned timestamp
    const b = fileFrom(patternBytes(SIZE, 2), 'build.zip', 315_532_800_000);
    expect(a.size).toBe(b.size);
    expect(await fingerprintFor(a)).not.toBe(await fingerprintFor(b));
  });

  it('notices a change confined to the last bytes of the file', async () => {
    // MUTATION: sample only the head -> an appended-to or patched tail is missed.
    const original = patternBytes(SIZE, 1);
    const changedTail = original.slice();
    changedTail[SIZE - 1] = (changedTail[SIZE - 1] as number) ^ 0xff;
    expect(await fingerprintFor(fileFrom(original, 'x.bin'))).not.toBe(await fingerprintFor(fileFrom(changedTail, 'x.bin')));
  });

  it('documents the remaining limit: a change only in the middle is not seen', async () => {
    // Not a goal — pinned so the limitation stated in the docs stays true, and so
    // anyone tightening it updates the docs too.
    const original = patternBytes(SIZE, 1);
    const changedMiddle = original.slice();
    changedMiddle[Math.floor(SIZE / 2)] = (changedMiddle[Math.floor(SIZE / 2)] as number) ^ 0xff;
    expect(await fingerprintFor(fileFrom(original, 'x.bin'))).toBe(await fingerprintFor(fileFrom(changedMiddle, 'x.bin')));
  });

  it('handles files smaller than one sample, and uses only characters the server accepts', async () => {
    for (const size of [1, 100, FINGERPRINT_SAMPLE_BYTES, FINGERPRINT_SAMPLE_BYTES + 1]) {
      const fp = await fingerprintFor(fileFrom(patternBytes(size, 5), 'tiny.txt'));
      expect(fp, String(size)).toMatch(/^[A-Za-z0-9._:-]{1,200}$/);
    }
  });
});
