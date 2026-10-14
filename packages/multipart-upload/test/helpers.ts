// Shared test helpers. Every test that touches disk gets its own temp root.

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MIB = 1024 * 1024;

const ENV_KEYS = [
  'MULTIPART_UPLOAD_MAX_FILE_BYTES',
  'MULTIPART_UPLOAD_PART_BYTES',
  'MULTIPART_UPLOAD_DIR',
  'MULTIPART_UPLOAD_PART_TTL_HOURS',
  'MULTIPART_UPLOAD_INSTANCE_ID',
] as const;

export function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

export async function tempRoot(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mpu-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Deterministic bytes where every position depends on its offset, so a part
 * placed at the wrong offset, dropped, or repeated changes the SHA-256. A buffer
 * of one repeated byte would hide exactly the bugs these tests exist for.
 */
export function patternBytes(size: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    // xorshift32 — deterministic, cheap, and offset-dependent.
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A File the client library can upload, backed by memory. */
export function fileFrom(bytes: Uint8Array<ArrayBuffer>, name = 'track.mp3', lastModified = 1_700_000_000_000): File {
  return new File([bytes], name, { lastModified });
}

/** Part `index` (1-based) of `bytes` at `partBytes`, exactly as the client slices it. */
export function partOf(bytes: Uint8Array<ArrayBuffer>, index: number, partBytes: number): Uint8Array<ArrayBuffer> {
  const start = (index - 1) * partBytes;
  return bytes.subarray(start, Math.min(start + partBytes, bytes.byteLength));
}
