// ---------------------------------------------------------------------------
// fingerprint.ts — a stable identifier for a file, derived, never random
// ---------------------------------------------------------------------------
//
// It lets the server tell "the same file again" (resume) from "a different file
// with the same name" (a separate upload). The server hashes it, with the name,
// size and MIME type, into the upload id and temporary folder; every part is
// also tagged with it, so it decides which stored parts belong to the file.
//
// DERIVED, NOT STORED. A random id kept in sessionStorage breaks the case resume
// exists for: sessionStorage is per-tab and cleared when the tab closes, so
// re-picking the same file after a reload produced a NEW id and a 409 instead of
// a resume. Everything here is computed from the file itself.
//
// IT SAMPLES CONTENT, not only metadata. Size + modification time + name is not
// enough: tools that pin timestamps (archive extraction, reproducible builds
// using SOURCE_DATE_EPOCH) produce DIFFERENT files with the same name, size and
// mtime. Those would get the same fingerprint, so the second would "resume" onto
// the first file's parts and store a mixture of both. Hashing the first and last
// 64 KB costs two small reads and separates them. Files differing only in the
// middle, with identical name, size, mtime, start and end, would still collide —
// a remaining, documented limitation.
//
// NOT CRYPTOGRAPHIC, deliberately. `crypto.subtle` needs a secure context, which
// would add an HTTPS-only failure on plain-HTTP intranet deployments for what is
// a mismatch detector, not a secret.
// ---------------------------------------------------------------------------

/** Bytes hashed from each end of the file. */
export const FINGERPRINT_SAMPLE_BYTES = 64 * 1024;

export interface FingerprintSource {
  readonly name: string;
  readonly size: number;
  readonly lastModified?: number;
  slice(start?: number, end?: number): Blob;
}

/** cyrb53: a fast, well-distributed 53-bit non-cryptographic hash. */
function cyrb53(data: Uint8Array | string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  const length = typeof data === 'string' ? data.length : data.byteLength;
  for (let i = 0; i < length; i += 1) {
    const code = typeof data === 'string' ? data.charCodeAt(i) : (data[i] as number);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

async function sampleOf(file: FingerprintSource): Promise<Uint8Array> {
  const head = new Uint8Array(await file.slice(0, FINGERPRINT_SAMPLE_BYTES).arrayBuffer());
  if (file.size <= FINGERPRINT_SAMPLE_BYTES) return head;
  const tail = new Uint8Array(
    await file.slice(Math.max(FINGERPRINT_SAMPLE_BYTES, file.size - FINGERPRINT_SAMPLE_BYTES), file.size).arrayBuffer(),
  );
  const both = new Uint8Array(head.byteLength + tail.byteLength);
  both.set(head, 0);
  both.set(tail, head.byteLength);
  return both;
}

/**
 * `<size>-<mtime>-<name hash>-<content hash>`, using only [0-9a-z-], which the
 * server's fingerprint pattern accepts.
 */
export async function fingerprintFor(file: FingerprintSource): Promise<string> {
  const content = cyrb53(await sampleOf(file), 1);
  return `${file.size}-${file.lastModified ?? 0}-${cyrb53(file.name)}-${content}`;
}
