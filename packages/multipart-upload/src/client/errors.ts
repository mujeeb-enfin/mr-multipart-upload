// ---------------------------------------------------------------------------
// errors.ts — what the client rejects with, and which failures are worth retrying
// ---------------------------------------------------------------------------

export class UploadClientError extends Error {
  /** HTTP status, or 0 for a network failure or a pause. */
  readonly status: number;
  /** Server error code (see UploadErrorCode), or 'PAUSED' / 'NETWORK'. */
  readonly code: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'UploadClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Whether a failed part is worth sending again.
 *
 * 408 and 429 are included on purpose: a large upload is EXPECTED to brush
 * against a rate limiter, and treating a single 429 as fatal would abort a
 * 200-part upload. PART_IN_FLIGHT means another request holds this exact part
 * right now — coming back to it is the documented response.
 *
 * Everything else in the 4xx range is terminal. A PART_LENGTH_MISMATCH or
 * FINGERPRINT_MISMATCH fails identically every time, and five retries would only
 * bury the real message.
 */
export function isRetryable(status: number, code: string | undefined): boolean {
  if (status === 0) return code !== 'PAUSED';
  if (status === 408 || status === 429) return true;
  if (status === 409 && code === 'PART_IN_FLIGHT') return true;
  return status >= 500;
}
