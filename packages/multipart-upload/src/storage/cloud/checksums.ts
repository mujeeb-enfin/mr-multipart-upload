// ---------------------------------------------------------------------------
// cloud/checksums.ts — composite checksum and Azure block ids
// ---------------------------------------------------------------------------
//
// COMPOSITE SHA-256. Neither S3 nor Azure computes a plain SHA-256 of a file
// uploaded in parts (S3's full-object checksums are CRC-only). S3 defines a
// "composite" checksum instead: SHA-256 over the concatenated binary SHA-256 of
// every part, in order. It was measured against an S3 implementation to match
// exactly (S3 renders it as base64 plus "-<parts>"). The same definition is used
// for Azure, so both backends report one comparable value.
//
// AZURE BLOCK IDS are ours to choose. Each is the 4-byte big-endian part index
// followed by the 32-byte part SHA-256: 36 bytes, so every id of a blob has the
// same length (Azure requires that), it sorts by index, and the part's hash can
// be read back from Get Block List — no upload id or extra file is needed.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import type { FileChecksum } from '../../core/session.js';

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

export function base64ToHex(base64: string): string {
  return Buffer.from(base64, 'base64').toString('hex');
}

/** Composite SHA-256 over per-part digests in order, or null if any is unknown. */
export function compositeSha256(partSha256s: readonly (string | undefined)[]): FileChecksum | null {
  if (partSha256s.length === 0 || partSha256s.some((h) => h === undefined || !HEX_SHA256.test(h))) return null;
  const hash = createHash('sha256');
  for (const hex of partSha256s) hash.update(Buffer.from(hex as string, 'hex'));
  return { type: 'sha256-composite', value: hash.digest('hex'), parts: partSha256s.length };
}

/** Azure block id for a part: base64(index as uint32 BE ‖ sha256). */
export function azureBlockId(index: number, sha256: string): string {
  if (!Number.isInteger(index) || index < 1 || index > 0xffffffff) throw new RangeError(`part index ${index}`);
  if (!HEX_SHA256.test(sha256)) throw new RangeError('sha256 must be 64 lowercase hex characters');
  const id = Buffer.alloc(36);
  id.writeUInt32BE(index, 0);
  Buffer.from(sha256, 'hex').copy(id, 4);
  return id.toString('base64');
}

/** The part a block id names, or null for a block this library did not stage. */
export function parseAzureBlockId(blockId: string): { index: number; sha256: string } | null {
  const raw = Buffer.from(blockId, 'base64');
  if (raw.length !== 36 || raw.toString('base64') !== blockId) return null;
  const index = raw.readUInt32BE(0);
  return index >= 1 ? { index, sha256: raw.subarray(4).toString('hex') } : null;
}

export function md5Base64(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('base64');
}
