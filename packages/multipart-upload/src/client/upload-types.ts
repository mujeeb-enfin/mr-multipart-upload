// ---------------------------------------------------------------------------
// upload-types.ts — the browser client's public types. Re-exported from
// upload.ts (and from `@mr_innovations/multipart-upload/client`), so importing
// them from either keeps working.
// ---------------------------------------------------------------------------

import type { PartSender } from './transport.js';

export type UploadPhase = 'starting' | 'uploading' | 'throttled' | 'assembling' | 'done';

export interface UploadProgress {
  readonly percent: number;
  readonly sentBytes: number;
  readonly totalBytes: number;
  readonly partsDone: number;
  readonly partsTotal: number;
  readonly phase: UploadPhase;
  /**
   * Parts allowed on the wire at once right now: the configured `concurrency`,
   * lower while recovering from throttling (see upload.ts).
   */
  readonly concurrency: number;
}

/** What the server reported when the upload began or resumed. */
export interface UploadStartInfo {
  readonly uploadId: string;
  readonly partCount: number;
  readonly partBytes: number;
  /** Bytes already on the server — non-zero means this is a resume. */
  readonly receivedBytes: number;
  readonly resumed: boolean;
  readonly maxFileBytes: number;
  /** 'proxy': parts go through the server. 'direct': straight to the storage. */
  readonly transfer: 'proxy' | 'direct';
}

/** The stored file's checksum, as the server reports it. */
export interface UploadChecksum {
  readonly type: 'sha256' | 'sha256-composite';
  readonly value: string;
  readonly parts?: number;
}

/** The server's response to `complete`. */
export interface UploadResult {
  readonly uploadId: string;
  readonly fileName: string;
  readonly key: string;
  readonly size: number;
  /** Exact SHA-256 of the stored file — local storage. Empty for cloud storage; see `checksum`. */
  readonly sha256: string;
  /** `sha256` (local) or `sha256-composite` (cloud), or null when none was verified. */
  readonly checksum: UploadChecksum | null;
  /** The stored file's type — detected from its content where the format allows. */
  readonly contentType: string;
  readonly deduplicated: boolean;
  /** Whatever the server's `onComplete` returned. */
  readonly result: unknown;
}

export type HeadersOption = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export interface StartUploadOptions {
  readonly file: Blob & { readonly name: string; readonly lastModified?: number };
  /** URL the server route is mounted at. Default '/api/uploads'. */
  readonly endpoint?: string;
  /** Extra headers on every request — or a function, for tokens that refresh. */
  readonly headers?: HeadersOption;
  /** JSON object stored with the upload and handed to the server's `onComplete`. */
  readonly metadata?: Record<string, unknown>;
  /**
   * Parts in flight at once (a whole number; default 4; Infinity = one per
   * part). On a 429, or a 503 from the storage, it drops to 1 and is earned
   * back as parts succeed — see upload.ts.
   */
  readonly concurrency?: number;
  /** Attempts per part before the upload fails (a whole number, at least 1; default 5). */
  readonly maxAttemptsPerPart?: number;
  readonly credentials?: RequestCredentials;
  readonly onStart?: (info: UploadStartInfo) => void;
  readonly onProgress?: (progress: UploadProgress) => void;
  /** Advanced: replace fetch for the control requests (begin/complete/discard). */
  readonly fetch?: typeof fetch;
  /** Advanced: replace the XMLHttpRequest part sender. */
  readonly sendPart?: PartSender;
}

export interface UploadHandle {
  readonly promise: Promise<UploadResult>;
  /** Stop sending but KEEP the server's parts, so the same file resumes later. */
  pause(): void;
  /** Stop and delete the server's parts. The only destructive action. */
  discard(): Promise<void>;
  /** Known once the server has answered `begin`. */
  readonly uploadId: string | null;
}
