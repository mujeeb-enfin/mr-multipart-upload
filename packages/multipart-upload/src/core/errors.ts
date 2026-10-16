// ---------------------------------------------------------------------------
// errors.ts — one error type, one stable code per failure, one HTTP status each
// ---------------------------------------------------------------------------
//
// Codes are part of the public contract: the browser client branches on them
// (`PART_IN_FLIGHT` is retried, `FINGERPRINT_MISMATCH` is not) and applications
// show messages keyed on them. Adding a code is fine; renaming one is a breaking
// change.
// ---------------------------------------------------------------------------

export type UploadErrorCode =
  /** An unfinished upload of a DIFFERENT file already uses this name. */
  | 'NAME_IN_USE'
  /** No upload in progress under this id for this caller. */
  | 'NO_SESSION'
  /** A part was sent for a different file than the session was started with. */
  | 'FINGERPRINT_MISMATCH'
  /** A part's body is not exactly the size its index requires. */
  | 'PART_LENGTH_MISMATCH'
  /**
   * A part's bytes do not match the SHA-256 the client computed before sending —
   * altered in transit. Nothing is written. Retryable: transient corruption
   * clears on a resend; a persistent cause fails loudly after the retries.
   */
  | 'PART_CHECKSUM_MISMATCH'
  /** A part index outside 1..partCount. */
  | 'PART_OUT_OF_RANGE'
  /** The session's parts live on another server instance. */
  | 'WRONG_INSTANCE'
  /** `complete` was called while parts are still missing. */
  | 'INCOMPLETE'
  /** Another `complete` for this upload is running right now. */
  | 'COMPLETE_IN_PROGRESS'
  /** Another request is writing this exact part right now. Retryable. */
  | 'PART_IN_FLIGHT'
  /** The file needs more parts than the naming scheme supports. */
  | 'TOO_MANY_PARTS'
  /** The file exceeds MULTIPART_UPLOAD_MAX_FILE_BYTES. */
  | 'FILE_TOO_LARGE'
  /**
   * The file's type is not in `allowedTypes` — refused at begin by its declared
   * type or extension, or at complete because its CONTENT is a different type
   * (e.g. an executable renamed to .png). On a content refusal the parts are kept.
   */
  | 'FILE_TYPE_NOT_ALLOWED'
  /** A request body (JSON or part) is larger than allowed. */
  | 'BODY_TOO_LARGE'
  /** Metadata exceeds the configured cap, or is not a JSON object. */
  | 'METADATA_TOO_LARGE'
  /** The file name cannot be turned into a safe upload id. */
  | 'INVALID_NAME'
  /** The request is malformed: bad JSON, missing field, bad header. */
  | 'INVALID_REQUEST'
  /**
   * The client went away before its request body arrived — normal when a user
   * pauses or discards. Not a server fault, so never reported through onError.
   */
  | 'CLIENT_DISCONNECTED'
  /** `validateHead` refused the file's contents. The parts are kept. */
  | 'REJECTED'
  /** `authorize` returned nothing or threw. */
  | 'UNAUTHORIZED'
  /** No route matches the method and path. */
  | 'NOT_FOUND'
  /** Server configuration is invalid — an `.env` value or an option. */
  | 'CONFIG_INVALID'
  /**
   * Cloud storage: an object this upload did not create already exists at its
   * storage key — usually a custom `destination()` that returns the same key for
   * different uploads. Nothing is overwritten; the parts are kept.
   */
  | 'DESTINATION_EXISTS';

const STATUS_FOR_CODE: Record<UploadErrorCode, number> = {
  NAME_IN_USE: 409,
  NO_SESSION: 404,
  FINGERPRINT_MISMATCH: 409,
  PART_LENGTH_MISMATCH: 400,
  PART_CHECKSUM_MISMATCH: 422,
  PART_OUT_OF_RANGE: 400,
  WRONG_INSTANCE: 409,
  INCOMPLETE: 409,
  COMPLETE_IN_PROGRESS: 409,
  // 409, not 503: nothing is wrong with the server. The client simply has to
  // come back to this index, and it does.
  PART_IN_FLIGHT: 409,
  TOO_MANY_PARTS: 422,
  FILE_TOO_LARGE: 413,
  FILE_TYPE_NOT_ALLOWED: 415,
  BODY_TOO_LARGE: 413,
  METADATA_TOO_LARGE: 413,
  INVALID_NAME: 400,
  INVALID_REQUEST: 400,
  CLIENT_DISCONNECTED: 400,
  REJECTED: 422,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFIG_INVALID: 500,
  DESTINATION_EXISTS: 409,
};

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly status: number;
  /** Extra, JSON-safe context returned to the client (e.g. `missingParts`). */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: UploadErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.status = STATUS_FOR_CODE[code];
    this.details = details;
  }
}

export function isUploadError(err: unknown): err is UploadError {
  return err instanceof UploadError;
}
