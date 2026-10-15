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
  /** The derived session id: sha256 of file name, size, MIME type and fingerprint. */
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
  /**
   * The DECLARED type at begin — the browser's File.type, or the extension's
   * usual type. FROZEN like metadata. Absent in manifests written before 0.2.0;
   * readers then derive it from the file name.
   */
  readonly contentType?: string;
  /**
   * Cloud backends only: the provider's multipart session. Written once at
   * begin. For S3 / MinIO this holds S3's UploadId — the one value in the
   * system that is not derived, so it is persisted where the derived upload id
   * points. Azure needs none: block ids are derived from the part.
   */
  readonly cloud?: CloudSessionRef;
  /**
   * Cloud backends only: set once the provider has committed the file. A
   * retried `complete` (after onComplete failed) then skips the commit — the
   * provider's parts no longer exist to commit again.
   */
  readonly committed?: CommittedFileRef;
  /**
   * Cloud backends only: written just BEFORE the provider commit. If the server
   * stops between that commit and recording `committed`, this marker is what
   * shows the object at the final key came from this upload — and not from an
   * earlier, completed upload of the same file, which shares the key.
   */
  readonly commitStartedAt?: string;
}

export interface CloudSessionRef {
  readonly kind: 'aws_s3' | 'minio' | 'azure_blob';
  /** Object key / blob name of the final file, fixed when the session begins. */
  readonly key: string;
  /** S3 / MinIO multipart UploadId. Absent for Azure. */
  readonly uploadId?: string;
}

export interface FileChecksum {
  /**
   * `sha256`: SHA-256 of the stored bytes (local storage).
   * `sha256-composite`: SHA-256 of the concatenated per-part SHA-256 digests —
   * S3's composite checksum definition; also used for Azure. Not the plain
   * SHA-256 of the file: S3 and Azure do not compute one for multipart uploads.
   */
  readonly type: 'sha256' | 'sha256-composite';
  /** Lowercase hex. */
  readonly value: string;
  /** Composite only: the number of parts it covers. */
  readonly parts?: number;
}

export interface CommittedFileRef {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  readonly checksum: FileChecksum | null;
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
