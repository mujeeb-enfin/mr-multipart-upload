// ---------------------------------------------------------------------------
// arithmetic.ts — part counts and boundaries
// ---------------------------------------------------------------------------
//
// Both failure modes here are SILENT, which is why every function is small and
// separately tested against real numbers:
//
//   - a wrong part count drops the tail of the file; the upload reports success
//     and the stored file is short;
//   - a wrong final-part size makes every file whose size is not an exact
//     multiple of the part size impossible to finish.
// ---------------------------------------------------------------------------

import { UploadError } from './errors.js';
import { MAX_PART_COUNT } from './layout.js';

/** Number of parts a file of `totalBytes` splits into. */
export function partCountFor(totalBytes: number, partBytes: number): number {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) {
    throw new UploadError('INVALID_REQUEST', `File size must be a positive integer, got ${totalBytes}`);
  }
  if (!Number.isInteger(partBytes) || partBytes <= 0) {
    throw new UploadError('CONFIG_INVALID', `Part size must be a positive integer, got ${partBytes}`);
  }
  // Ceiling: the final part is short unless the size divides exactly. Flooring
  // silently drops the tail of every file that is not an exact multiple.
  const count = Math.ceil(totalBytes / partBytes);
  if (count > MAX_PART_COUNT) {
    throw new UploadError('TOO_MANY_PARTS', `${count} parts exceeds the maximum of ${MAX_PART_COUNT}`);
  }
  return count;
}

/**
 * Size the part at `index` must have.
 *
 * Every part is `partBytes` except the last, which carries the remainder. This
 * is what the server compares an uploaded body against, and what the resume
 * scan compares a file's size against — so a short or torn part is detected
 * rather than assembled.
 */
export function expectedPartBytes(index: number, partBytes: number, totalBytes: number): number {
  const count = partCountFor(totalBytes, partBytes);
  if (!Number.isInteger(index) || index < 1 || index > count) {
    throw new UploadError('PART_OUT_OF_RANGE', `Part index ${index} is outside 1..${count}`);
  }
  if (index < count) return partBytes;
  const remainder = totalBytes % partBytes;
  // An exact multiple has a FULL final part, not a zero-length one.
  return remainder === 0 ? partBytes : remainder;
}

/**
 * Byte range a part covers, INCLUSIVE at both ends.
 *
 * The browser never uses this: `Blob.slice`'s end is EXCLUSIVE, and the client
 * computes its own bounds so the two conventions never meet in one expression.
 */
export function partByteRange(
  index: number,
  partBytes: number,
  totalBytes: number,
): { startInclusive: number; endInclusive: number } {
  const size = expectedPartBytes(index, partBytes, totalBytes);
  const startInclusive = (index - 1) * partBytes;
  return { startInclusive, endInclusive: startInclusive + size - 1 };
}
