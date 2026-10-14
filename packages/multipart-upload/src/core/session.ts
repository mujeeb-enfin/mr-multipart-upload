// ---------------------------------------------------------------------------
// session.ts — the manifest, and the resume state derived from it
// ---------------------------------------------------------------------------

import { expectedPartBytes } from './arithmetic.js';

/** Any JSON value. Metadata is stored in the manifest as-is. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type UploadMetadata = { [key: string]: JsonValue };

export interface UploadManifest {
  readonly v: 1;
  /** The derived session id — the slugified file name. */
  readonly uploadId: string;
  /** Hashed namespace directory this session belongs to. */
  readonly namespaceKey: string;
  /** The original file name, kept so a collision can name BOTH files. */
  readonly fileName: string;
  readonly totalBytes: number;
  /**
   * FROZEN at begin. Every later computation reads this, never the current
   * configuration — otherwise changing MULTIPART_UPLOAD_PART_BYTES mid-upload
   * shifts every boundary and silently invalidates the parts already received.
   */
  readonly partBytes: number;
  readonly partCount: number;
  /** Derived from the file (size, mtime, name) by the client. Never random. */
  readonly fingerprint: string;
  readonly instanceId: string;
  readonly createdAt: string;
  /**
   * Caller metadata, captured at begin and FROZEN. Read by `complete` from here
   * rather than re-sent, so a replayed or tampered `complete` cannot change what
   * was approved when the upload started.
   */
  readonly metadata: UploadMetadata;
}

export interface UploadSession {
  readonly manifest: UploadManifest;
  /** 1-based, ascending, size-verified. */
  readonly receivedParts: readonly number[];
  readonly missingParts: readonly number[];
  readonly receivedBytes: number;
  readonly complete: boolean;
}

/**
 * Split verified part indices into what is present and what is still needed.
 *
 * Pure, so the resume computation is testable without a filesystem: the storage
 * layer's only job is to produce `present` by listing and checking sizes.
 */
export function summariseSession(manifest: UploadManifest, present: Iterable<number>): UploadSession {
  const seen = new Set<number>();
  for (const index of present) {
    if (Number.isInteger(index) && index >= 1 && index <= manifest.partCount) seen.add(index);
  }

  const receivedParts: number[] = [];
  const missingParts: number[] = [];
  let receivedBytes = 0;

  for (let index = 1; index <= manifest.partCount; index += 1) {
    if (seen.has(index)) {
      receivedParts.push(index);
      // The real size of each part, so a short final part never pushes
      // progress past 100%.
      receivedBytes += expectedPartBytes(index, manifest.partBytes, manifest.totalBytes);
    } else {
      missingParts.push(index);
    }
  }

  return { manifest, receivedParts, missingParts, receivedBytes, complete: missingParts.length === 0 };
}

/**
 * True when an existing manifest describes the same upload as a new request.
 *
 * All three must agree. Checking only the fingerprint would let a changed part
 * size resume onto parts cut at different boundaries — producing a file of the
 * right length with the wrong contents.
 */
export function manifestMatches(
  manifest: UploadManifest,
  candidate: { totalBytes: number; partBytes: number; fingerprint: string },
): boolean {
  return (
    manifest.totalBytes === candidate.totalBytes &&
    manifest.partBytes === candidate.partBytes &&
    manifest.fingerprint === candidate.fingerprint
  );
}
