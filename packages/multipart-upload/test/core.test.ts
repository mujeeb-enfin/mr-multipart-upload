// ---------------------------------------------------------------------------
// core.test.ts — part arithmetic, naming, resume state, upload ids
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. The arithmetic that decides where one part ends and the
// next begins, and the naming that lets a resume work out what is already on
// disk. Every failure here is SILENT — a short file, or a hole assembled as if it
// were complete — so each is asserted against the real numbers a 400 MB upload
// produces. Each test names the mutation it must fail against.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { expectedPartBytes, partByteRange, partCountFor } from '../src/core/arithmetic.js';
import { UploadError } from '../src/core/errors.js';
import { describeByteSize, formatByteSize } from '../src/core/format.js';
import {
  LOCK_FILE,
  MANIFEST_FILE,
  MAX_PART_COUNT,
  PART_NUMBER_WIDTH,
  STAGING_FILE,
  parsePartFileName,
  partFileName,
  partIndexFromFileName,
  partKey,
} from '../src/core/layout.js';
import { type UploadManifest, manifestMatches, summariseSession } from '../src/core/session.js';
import { assertSafeUploadId, slugifyFileName, uploadIdForFileName } from '../src/core/slug.js';
import { MIB } from './helpers.js';

const TOTAL = 400 * MIB;
const PART = 2 * MIB;

function manifest(overrides: Partial<UploadManifest> = {}): UploadManifest {
  return {
    v: 1,
    uploadId: 'cafe-ambience-mp3',
    namespaceKey: '0'.repeat(32),
    fileName: 'Café Ambience.mp3',
    totalBytes: TOTAL,
    partBytes: PART,
    partCount: partCountFor(TOTAL, PART),
    fingerprint: '419430400-1730000000-abc123',
    instanceId: 'single',
    createdAt: '2026-10-14T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

describe('partCountFor', () => {
  it('splits a 400 MB file at 2 MiB into exactly 200 parts', () => {
    expect(partCountFor(TOTAL, PART)).toBe(200);
    expect(partCountFor(TOTAL, MIB)).toBe(400);
  });

  it('rounds UP so the tail is never dropped', () => {
    // MUTATION: Math.ceil -> Math.floor. A size that does NOT divide evenly is
    // used, because for an exact multiple floor and ceil agree.
    expect(partCountFor(TOTAL + MIB, PART)).toBe(201);
    expect(partCountFor(1, PART)).toBe(1);
    expect(partCountFor(PART + 1, PART)).toBe(2);
  });

  it('refuses a part count beyond the filename padding', () => {
    expect(() => partCountFor(MAX_PART_COUNT * 2 * MIB, MIB)).toThrow(/exceeds the maximum/);
  });

  it('refuses a non-positive or fractional size', () => {
    for (const bad of [0, -1, 1.5]) expect(() => partCountFor(bad, PART)).toThrow(/positive integer/);
    expect(() => partCountFor(TOTAL, 0)).toThrow(/positive integer/);
  });
});

describe('expectedPartBytes', () => {
  it('gives every part the full size except a short last one', () => {
    // MUTATION: return partBytes unconditionally -> the final part of a 401 MB
    // file is demanded at 2 MiB, rejected, and the upload can never finish.
    const odd = TOTAL + 12345;
    expect(expectedPartBytes(200, PART, odd)).toBe(PART);
    expect(expectedPartBytes(201, PART, odd)).toBe(12345);
  });

  it('treats an exact multiple as a full final part, not a zero-length one', () => {
    // MUTATION: drop the `remainder === 0` branch -> final part expected at 0 bytes.
    expect(expectedPartBytes(200, PART, TOTAL)).toBe(PART);
    expect(expectedPartBytes(1, PART, PART)).toBe(PART);
  });

  it('sums to exactly the file size across every part', () => {
    const odd = 400 * MIB + 7;
    let sum = 0;
    for (let i = 1; i <= partCountFor(odd, PART); i += 1) sum += expectedPartBytes(i, PART, odd);
    expect(sum).toBe(odd);
  });

  it('refuses an index outside the real part count', () => {
    expect(() => expectedPartBytes(0, PART, TOTAL)).toThrow(/outside 1\.\.200/);
    expect(() => expectedPartBytes(201, PART, TOTAL)).toThrow(/outside 1\.\.200/);
  });
});

describe('partByteRange', () => {
  it('is inclusive at both ends and contiguous', () => {
    // MUTATION: drop the `- 1` -> ranges overlap by one byte.
    const first = partByteRange(1, PART, TOTAL);
    expect(first).toEqual({ startInclusive: 0, endInclusive: PART - 1 });
    expect(partByteRange(2, PART, TOTAL).startInclusive).toBe(first.endInclusive + 1);
  });

  it('ends the last range on the final byte of the file', () => {
    const odd = TOTAL + 12345;
    expect(partByteRange(partCountFor(odd, PART), PART, odd).endInclusive).toBe(odd - 1);
  });
});

const TAG = '3f9a1c07b2d4e816';
const OTHER_TAG = '0123456789abcdef';

describe('part filenames', () => {
  it('pads to six digits and carries the part tag', () => {
    expect(PART_NUMBER_WIDTH).toBe(6);
    expect(partFileName(1, TAG)).toBe(`000001.${TAG}.part`);
    expect(partFileName(MAX_PART_COUNT, TAG)).toBe(`999999.${TAG}.part`);
  });

  it('sorts lexically in numeric order beyond three digits', () => {
    // MUTATION: PART_NUMBER_WIDTH = 3 -> '1000.…' sorts before '999.…'.
    const indices = [1, 2, 9, 10, 99, 100, 999, 1000, 1001, 99999, 100000];
    const names = indices.map((i) => partFileName(i, TAG));
    expect([...names].sort()).toEqual(names);
  });

  it('builds a namespaced key with no random component', () => {
    const ns = 'a'.repeat(32);
    expect(partKey(ns, 'cafe-mp3', 11, TAG)).toBe(`.parts/${ns}/cafe-mp3/000011.${TAG}.part`);
    expect(partKey(ns, 'cafe-mp3', 11, TAG)).toBe(partKey(ns, 'cafe-mp3', 11, TAG));
  });

  it('refuses an out-of-range index or a malformed tag', () => {
    expect(() => partFileName(0, TAG)).toThrow(UploadError);
    expect(() => partFileName(MAX_PART_COUNT + 1, TAG)).toThrow(/out of range/);
    expect(() => partFileName(1.5, TAG)).toThrow(/out of range/);
    for (const bad of ['', 'ABCDEF0123456789', '3f9a1c07b2d4e81', '../../../../etc', '3f9a1c07b2d4e816x']) {
      expect(() => partFileName(1, bad), bad).toThrow(/Part tag/);
    }
  });
});

describe('partIndexFromFileName', () => {
  it('REFUSES every non-part entry that shares the directory', () => {
    // MUTATION: unanchor the pattern -> the manifest, staging file or lock is
    // counted as a received part and `complete` assembles a hole.
    for (const name of [
      MANIFEST_FILE, STAGING_FILE, LOCK_FILE, `000011.${TAG}.part.tmp`, `x000011.${TAG}.part`,
      `000011.${TAG}.parts`, `00011.${TAG}.part`, `0000011.${TAG}.part`, `000011.${TAG}.PART`,
      '000011.part', '', '.', '..', `000000.${TAG}.part`,
    ]) {
      expect(partIndexFromFileName(name, TAG), name).toBeNull();
    }
  });

  it('IGNORES a part belonging to a different file — the orphan case', () => {
    // MUTATION: drop the tag comparison -> a correctly-sized orphan of another
    // file under the same name is counted as received and assembled in.
    expect(partIndexFromFileName(partFileName(2, OTHER_TAG), TAG)).toBeNull();
    expect(parsePartFileName(partFileName(2, OTHER_TAG))).toEqual({ index: 2, tag: OTHER_TAG });
  });

  it('round-trips with partFileName at every boundary', () => {
    for (const index of [1, 2, 199, 200, 201, MAX_PART_COUNT]) {
      expect(partIndexFromFileName(partFileName(index, TAG), TAG)).toBe(index);
    }
  });
});

describe('summariseSession', () => {
  it('reports the resume state after an interruption at 10 of 200 parts', () => {
    const session = summariseSession(manifest(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(session.receivedParts).toHaveLength(10);
    expect(session.missingParts).toHaveLength(190);
    expect(session.missingParts[0]).toBe(11);
    expect(session.missingParts.at(-1)).toBe(200);
    expect(session.receivedBytes).toBe(10 * PART);
    expect(session.complete).toBe(false);
  });

  it('ignores indices outside the part count and de-duplicates', () => {
    const session = summariseSession(manifest(), [1, 1, 2, 999, 0, -5]);
    expect(session.receivedParts).toEqual([1, 2]);
    expect(session.receivedBytes).toBe(2 * PART);
  });

  it('counts a short final part at its real size', () => {
    // MUTATION: use partBytes for every index -> progress passes 100%.
    const odd = PART * 2 + 500;
    const session = summariseSession(manifest({ totalBytes: odd, partCount: 3 }), [1, 2, 3]);
    expect(session.receivedBytes).toBe(odd);
    expect(session.complete).toBe(true);
  });
});

describe('manifestMatches', () => {
  const base = manifest();
  const same = { totalBytes: TOTAL, partBytes: PART, fingerprint: base.fingerprint };

  it('matches only when size, part size and fingerprint all agree', () => {
    expect(manifestMatches(base, same)).toBe(true);
    expect(manifestMatches(base, { ...same, fingerprint: 'other-file' })).toBe(false);
    expect(manifestMatches(base, { ...same, totalBytes: TOTAL + 1 })).toBe(false);
    // MUTATION: compare only the fingerprint -> a resume after the part size
    // changed is accepted onto parts cut at different boundaries.
    expect(manifestMatches(base, { ...same, partBytes: MIB })).toBe(false);
  });
});

describe('upload ids from file names', () => {
  it('folds accents and case, keeps the extension, collapses separators', () => {
    expect(slugifyFileName('Café Ambience.mp3')).toBe('cafe-ambience-mp3');
    expect(slugifyFileName('Vol. 2  (Remastered).FLAC')).toBe('vol-2-remastered-flac');
    // The extension is what keeps these two apart.
    expect(uploadIdForFileName('photo.jpg')).not.toBe(uploadIdForFileName('photo.png'));
  });

  it('neutralises traversal attempts', () => {
    expect(uploadIdForFileName('../../../etc/passwd')).toBe('etc-passwd');
    expect(uploadIdForFileName('..\\..\\windows\\win.ini')).toBe('windows-win-ini');
  });

  it('REFUSES a name with nothing to build an id from', () => {
    // MUTATION: drop the empty check -> every CJK-only file shares one session.
    expect(() => uploadIdForFileName('日本語')).toThrow(/at least one Latin letter or digit/);
    expect(() => uploadIdForFileName('🎵🎵')).toThrow(UploadError);
  });

  it('refuses Windows device names and anything outside the allowlist', () => {
    expect(() => assertSafeUploadId('con')).toThrow(/reserved device name/);
    for (const bad of ['UPPER', 'has.dot', '-leading', 'a/b', 'a\\b', '..', '.', 'x'.repeat(81)]) {
      expect(() => assertSafeUploadId(bad), bad).toThrow(UploadError);
    }
  });

  it('trims a hyphen exposed by truncation', () => {
    const id = slugifyFileName(`${'a'.repeat(79)} b`);
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id.endsWith('-')).toBe(false);
  });
});

describe('byte sizes in messages', () => {
  // Protects the refusal message people read: "189963874 bytes" was shown raw.
  it('formats sizes in the units a file picker shows', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(40 * MIB)).toBe('40 MB');
    expect(formatByteSize(189_963_874)).toBe('181 MB');
    expect(formatByteSize(1.5 * 1024 * MIB)).toBe('1.5 GB');
  });

  it('keeps the exact byte count alongside', () => {
    expect(describeByteSize(189_963_874)).toBe('181 MB (189,963,874 bytes)');
    expect(describeByteSize(41_943_040)).toBe('40 MB (41,943,040 bytes)');
  });
});
