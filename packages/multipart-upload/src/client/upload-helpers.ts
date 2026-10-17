// ---------------------------------------------------------------------------
// upload-helpers.ts — the pure helpers upload.ts uses: hashing, waiting,
// backoff and error decoding. No state; no timers (AbortSignal.timeout only).
// ---------------------------------------------------------------------------

import { UploadClientError } from './errors.js';

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * SHA-256 of a part, or null where the browser cannot compute it.
 *
 * `crypto.subtle` exists only in secure contexts (HTTPS, or localhost). On a
 * plain-HTTP host the checksum is skipped and the server does not verify — the
 * upload still works, without the transit-integrity guarantee.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Wait, event-driven; resolves early when any of `signals` aborts. Every
 * listener is removed when the wait ends, so a long, often-retried upload does
 * not pile listeners onto its long-lived signals.
 */
export function delay(ms: number, ...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    if (signals.some((s) => s.aborted)) return resolve();
    const timer = AbortSignal.timeout(ms);
    const all = [timer, ...signals];
    const done = () => {
      for (const s of all) s.removeEventListener('abort', done);
      resolve();
    };
    for (const s of all) s.addEventListener('abort', done, { once: true });
  });
}

export function backoffFor(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  // Jitter, so parts that failed together do not all return at once.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

export function errorFrom(status: number, body: unknown, fallback: string): UploadClientError {
  const error = (body as { error?: { message?: string; code?: string; details?: Record<string, unknown> } } | null)?.error;
  return new UploadClientError(error?.message ?? fallback, status, error?.code, error?.details);
}
