// ---------------------------------------------------------------------------
// cloud-checksums.test.ts — the hashing the cloud backends depend on
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. Azure rejects a block whose Content-MD5 is wrong, so the
// browser's MD5 must equal the real MD5 at every length (padding boundaries
// included). Block ids must round-trip the part index and SHA-256, keep one
// length, and reject ids this library did not create. The composite checksum
// must match S3's definition, computed here independently.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { md5, md5Base64 } from '../src/client/md5.js';
import { azureBlockId, compositeSha256, parseAzureBlockId } from '../src/storage/cloud/checksums.js';
import { patternBytes } from './helpers.js';

describe('browser MD5 (Azure Content-MD5)', () => {
  it('matches Node\'s MD5 at every length around the padding boundaries and beyond', () => {
    // MUTATION: a wrong round constant, shift or padding rule -> the cases below
    // differ. (The bit length's HIGH word only matters from 512 MiB, far above
    // the 8 MiB part cap, so it is not exercised here.)
    const lengths = [0, 1, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 4096, 65_537, 5 * 1024 * 1024];
    for (const length of lengths) {
      const bytes = patternBytes(length, length + 1);
      expect(Buffer.from(md5(bytes)).toString('hex'), `length ${length}`).toBe(createHash('md5').update(bytes).digest('hex'));
    }
  });

  it('gives the base64 form Azure expects, and accepts an ArrayBuffer', () => {
    const bytes = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
    expect(md5Base64(bytes)).toBe('nhB9nTcrtoJr2B01QqQZ1g==');
    expect(md5Base64(bytes.buffer)).toBe('nhB9nTcrtoJr2B01QqQZ1g==');
  });
});

describe('Azure block ids', () => {
  const sha = createHash('sha256').update('part').digest('hex');

  it('round-trip the index and SHA-256 at a fixed length', () => {
    const ids = [1, 2, 999, 50_000].map((i) => azureBlockId(i, sha));
    expect(new Set(ids.map((id) => id.length))).toEqual(new Set([48])); // 36 bytes → 48 base64 chars
    expect(ids.map((id) => parseAzureBlockId(id))).toEqual([1, 2, 999, 50_000].map((index) => ({ index, sha256: sha })));
  });

  it('carries a session tag at a fixed length, so sessions sharing a blob tell their blocks apart', () => {
    // Azure requires every block id of a blob to have the same length: 44 bytes
    // for every tagged id. The tag must round-trip exactly — listParts keeps a
    // block only when its tag is the session's own.
    const tag = '0123456789abcdef';
    const ids = [1, 2, 50_000].map((i) => azureBlockId(i, sha, tag));
    expect(new Set(ids.map((id) => id.length))).toEqual(new Set([60])); // 44 bytes → 60 base64 chars
    expect(ids.map((id) => parseAzureBlockId(id))).toEqual([1, 2, 50_000].map((index) => ({ index, sha256: sha, sessionTag: tag })));
    expect(azureBlockId(1, sha, tag)).not.toBe(azureBlockId(1, sha, 'fedcba9876543210'));
    expect(parseAzureBlockId(azureBlockId(1, sha))).not.toHaveProperty('sessionTag'); // untagged (older sessions)
    expect(() => azureBlockId(1, sha, 'not-a-tag')).toThrow(RangeError);
  });

  it('rejects ids this library did not stage', () => {
    expect(parseAzureBlockId(Buffer.from('foreign-block').toString('base64'))).toBeNull();
    expect(parseAzureBlockId(Buffer.alloc(36).toString('base64'))).toBeNull(); // index 0
    expect(() => azureBlockId(0, sha)).toThrow(RangeError);
    expect(() => azureBlockId(1, 'not-hex')).toThrow(RangeError);
  });
});

describe('composite SHA-256', () => {
  it('is the SHA-256 of the concatenated part digests (S3\'s definition)', () => {
    const parts = [patternBytes(5 * 1024 * 1024, 1), patternBytes(10, 2)];
    const digests = parts.map((p) => createHash('sha256').update(p).digest());
    const expected = createHash('sha256').update(Buffer.concat(digests)).digest('hex');
    expect(compositeSha256(digests.map((d) => d.toString('hex')))).toEqual({ type: 'sha256-composite', value: expected, parts: 2 });
  });

  it('is null when any part digest is missing or malformed, never a partial value', () => {
    expect(compositeSha256(['a'.repeat(64), undefined])).toBeNull();
    expect(compositeSha256(['xyz'])).toBeNull();
    expect(compositeSha256([])).toBeNull();
  });
});
