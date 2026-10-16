// ---------------------------------------------------------------------------
// cloud/types.ts — what a cloud storage backend provides
// ---------------------------------------------------------------------------
//
// Two halves, because a cloud multipart upload has two kinds of state:
//
//   control   small files the library owns — manifest, lock, head bytes,
//             activity marker — stored as ordinary objects in the bucket /
//             container. It is a StorageAdapter, so the manifest, lock and
//             sweep logic that works on the filesystem works here unchanged.
//
//   parts     the file's bytes, inside the PROVIDER'S multipart session:
//             S3 CreateMultipartUpload / UploadPart / CompleteMultipartUpload,
//             Azure Put Block / Put Block List. The provider assembles them;
//             nothing is downloaded and re-uploaded.
// ---------------------------------------------------------------------------

import type { CloudSessionRef, FileChecksum } from '../../core/session.js';
import type { StorageAdapter } from '../adapter.js';

export type CloudStorageKind = CloudSessionRef['kind'];

/** One part the provider holds. */
export interface CloudPart {
  /** 1-based. */
  readonly index: number;
  readonly size: number;
  /** Lowercase hex SHA-256 the provider recorded for the part, when it has one. */
  readonly sha256: string | undefined;
  /** S3 / MinIO: the ETag CompleteMultipartUpload needs. */
  readonly etag?: string;
}

/** A request the browser sends straight to the provider (direct transfer). */
export interface DirectPartRequest {
  readonly url: string;
  readonly method: 'PUT';
  /** Headers the browser MUST send unchanged — they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  /** ISO-8601. After this the provider refuses the request; ask for a new one. */
  readonly expiresAt: string;
}

export interface CloudCommitResult {
  readonly key: string;
  readonly size: number;
  readonly checksum: FileChecksum | null;
}

export interface CloudBackend {
  readonly kind: CloudStorageKind;
  /** Control files (manifest, lock, head, activity) as objects. */
  readonly control: StorageAdapter;
  /**
   * Checksums the browser must send with a DIRECT part, besides the SHA-256 the
   * server signs. Azure verifies MD5 per block (it has no SHA-256 check).
   */
  readonly directChecksums: readonly ('sha256' | 'md5')[];
  /** True when this configuration can issue direct-transfer URLs. */
  readonly supportsDirect: boolean;

  /**
   * Start the provider's multipart session for the final object `key`. With
   * `stagingKey` (Azure direct transfer) parts go to that blob instead, and
   * `commit` copies it to `key` — the browser's URLs never name the final key.
   */
  createSession(key: string, contentType: string, stagingKey?: string): Promise<CloudSessionRef>;
  /** Discard an unfinished session and everything uploaded into it. Absent is success. */
  abortSession(session: CloudSessionRef): Promise<void>;
  /** Store one part sent through the server. `sha256` is verified lowercase hex. */
  putPart(session: CloudSessionRef, index: number, bytes: Uint8Array, sha256: string): Promise<void>;
  /** A signed request the browser can send the part with, for `ttlSeconds`. */
  presignPart(
    session: CloudSessionRef,
    index: number,
    length: number,
    sha256: string,
    md5Base64: string | undefined,
    ttlSeconds: number,
  ): Promise<DirectPartRequest>;
  /** Every part the provider holds for the session. */
  listParts(session: CloudSessionRef): Promise<CloudPart[]>;
  /** Commit `parts` (ascending, complete) into the final object. */
  commit(session: CloudSessionRef, parts: readonly CloudPart[], contentType: string): Promise<CloudCommitResult>;
  /** The first `byteCount` bytes of a committed object. */
  readObjectHead(key: string, byteCount: number): Promise<Uint8Array>;
  /** Delete a committed object. Absent is success. */
  deleteObject(key: string): Promise<void>;
  /** Stream a committed object. */
  openRead(key: string): ReadableStream<Uint8Array>;
}
