// ---------------------------------------------------------------------------
// upload.ts — slice a file, send the missing parts, finish the upload
// ---------------------------------------------------------------------------
//
// Resume needs nothing from the browser: the server derives the upload from the
// file name and fingerprint, answers `begin` with the parts it is missing, and
// only those are sent. Picking the same file after a reload resumes it.
//
// PROGRESS NEVER GOES BACKWARDS. A finished part is pinned at its full size and
// never written again; a retry would otherwise reset its `loaded` to 0 and the
// bar would visibly run backwards. A resumed upload starts at its real
// percentage, and 100% is reserved for a COMPLETED assembly — assembling a large
// file is a real multi-second wait that must not look like a hang.
//
// THROTTLING ACTUALLY THROTTLES. On a 429 the upload drops to one part at a time
// for the rest of the run. The original implementation set `concurrency = 1` but
// its workers were already running and each kept pulling from the queue, so the
// drop never took effect. Two rules close it here:
//
//   - a worker checks its slot before taking a part, and stops if the slot is no
//     longer allowed;
//   - a worker whose slot is no longer allowed does not retry a failed part
//     itself — it hands the part back to the FRONT of the queue for the
//     remaining worker. Retrying in place would put the throttled part on the
//     wire alongside the surviving worker's part: two at once, again.
//
// Attempts are counted per part, not per worker, so requeueing a part can never
// reset its retry limit.
//
// NO setTimeout: backoff waits on AbortSignal.timeout, and a pause cuts it short.
// ---------------------------------------------------------------------------

import { UploadClientError, isRetryable } from './errors.js';
import { fingerprintFor } from './fingerprint.js';
import { type PartSender, xhrPartSender } from './transport.js';

export const FINGERPRINT_HEADER = 'x-upload-fingerprint';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export type UploadPhase = 'starting' | 'uploading' | 'throttled' | 'assembling' | 'done';

export interface UploadProgress {
  readonly percent: number;
  readonly sentBytes: number;
  readonly totalBytes: number;
  readonly partsDone: number;
  readonly partsTotal: number;
  readonly phase: UploadPhase;
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
}

/** The server's response to `complete`. */
export interface UploadResult {
  readonly uploadId: string;
  readonly fileName: string;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
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
  /** Parts in flight at once. Default 4; drops to 1 for the rest of the run on a 429. */
  readonly concurrency?: number;
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

/** Wait, event-driven; resolves early when `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = AbortSignal.timeout(ms);
    const done = () => resolve();
    timer.addEventListener('abort', done, { once: true });
    signal.addEventListener('abort', done, { once: true });
  });
}

function backoffFor(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  // Jitter, so parts that failed together do not all return at once.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

function errorFrom(status: number, body: unknown, fallback: string): UploadClientError {
  const error = (body as { error?: { message?: string; code?: string; details?: Record<string, unknown> } } | null)?.error;
  return new UploadClientError(error?.message ?? fallback, status, error?.code, error?.details);
}

export function startUpload(options: StartUploadOptions): UploadHandle {
  const { file, onProgress } = options;
  const endpoint = (options.endpoint ?? '/api/uploads').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const sendPart = options.sendPart ?? xhrPartSender;
  const credentials = options.credentials ?? 'same-origin';
  const maxAttempts = options.maxAttemptsPerPart ?? DEFAULT_MAX_ATTEMPTS;
  const fingerprint = fingerprintFor(file);
  const controller = new AbortController();

  let uploadId: string | null = null;
  let concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  let phase: UploadPhase = 'starting';
  let partBytes = 0;
  let partCount = 0;
  const sentByPart = new Map<number, number>();
  const settled = new Set<number>();

  async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const base = typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
    return { ...base, ...extra };
  }

  function report(): void {
    if (!onProgress) return;
    let sent = 0;
    for (const value of sentByPart.values()) sent += value;
    const sentBytes = Math.min(sent, file.size);
    const percent =
      phase === 'done' ? 100 : Math.min(99, file.size === 0 ? 0 : Math.round((sentBytes / file.size) * 100));
    onProgress({ percent, sentBytes, totalBytes: file.size, partsDone: settled.size, partsTotal: partCount, phase });
  }

  async function control<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method,
        credentials,
        signal: method === 'DELETE' ? undefined : controller.signal,
        headers: await headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (controller.signal.aborted && method !== 'DELETE') throw new UploadClientError('Paused.', 0, 'PAUSED');
      throw new UploadClientError(err instanceof Error ? err.message : 'Network error', 0, 'NETWORK');
    }
    if (response.status === 204) return null;
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) throw errorFrom(response.status, parsed, `Request failed (${response.status})`);
    return parsed as T;
  }

  function sliceFor(index: number): Blob {
    // Blob.slice's end is EXCLUSIVE; the server's byte ranges are inclusive. The
    // client computes exclusive bounds directly so the conventions never mix.
    const start = (index - 1) * partBytes;
    return file.slice(start, Math.min(start + partBytes, file.size));
  }

  const attemptsByPart = new Map<number, number>();

  /**
   * Upload one part, retrying on retryable failures.
   * @returns 'done', or 'requeue' when this worker's slot was withdrawn by a 429
   *   and the part must be retried by the remaining worker instead.
   */
  async function uploadOne(index: number, slot: number): Promise<'done' | 'requeue'> {
    const body = sliceFor(index);
    for (;;) {
      const attempt = (attemptsByPart.get(index) ?? 0) + 1;
      attemptsByPart.set(index, attempt);
      if (controller.signal.aborted) throw new UploadClientError('Paused.', 0, 'PAUSED');
      const response = await sendPart({
        url: `${endpoint}/${encodeURIComponent(uploadId as string)}/parts/${index}`,
        body,
        credentials,
        signal: controller.signal,
        headers: await headers({ 'content-type': 'application/octet-stream', [FINGERPRINT_HEADER]: fingerprint }),
        onProgress: (loaded) => {
          if (settled.has(index)) return;
          sentByPart.set(index, loaded);
          report();
        },
      }).catch((err: unknown) => {
        if (err instanceof UploadClientError) return err;
        return new UploadClientError(String(err), 0, 'NETWORK');
      });

      const failure =
        response instanceof UploadClientError
          ? response
          : response.status >= 200 && response.status < 300
            ? null
            : Object.assign(errorFrom(response.status, response.body, `Part ${index} failed (${response.status})`), {
                retryAfterSeconds: response.retryAfterSeconds,
              });

      if (!failure) {
        settled.add(index);
        sentByPart.set(index, body.size); // pinned: never written again
        report();
        return 'done';
      }
      // Credit nothing for a failed attempt, so the bar does not sit at a number
      // this part never reached.
      sentByPart.delete(index);
      if (failure.code === 'PAUSED' || controller.signal.aborted) throw failure;
      if (!isRetryable(failure.status, failure.code) || attempt === maxAttempts) throw failure;

      if (failure.status === 429) {
        // Self-limit for the rest of the run rather than oscillate: an upload that
        // finishes slowly beats one that keeps tripping the limiter.
        concurrency = 1;
        phase = 'throttled';
      }
      report();
      await delay(backoffFor(attempt, (failure as { retryAfterSeconds?: number | null }).retryAfterSeconds ?? null), controller.signal);
      // Re-checked AFTER the backoff: another worker's 429 may have withdrawn
      // this slot while it waited.
      if (slot >= concurrency) return 'requeue';
    }
  }

  async function run(): Promise<UploadResult> {
    const begun = await control<UploadStartInfo & { missingParts: number[] }>('POST', '', {
      fileName: file.name,
      totalBytes: file.size,
      fingerprint,
      metadata: options.metadata ?? {},
    });
    if (!begun) throw new UploadClientError('The server did not start the upload.', 0);

    uploadId = begun.uploadId;
    partBytes = begun.partBytes;
    partCount = begun.partCount;
    options.onStart?.({
      uploadId: begun.uploadId,
      partCount,
      partBytes,
      receivedBytes: begun.receivedBytes,
      resumed: begun.receivedBytes > 0,
      maxFileBytes: begun.maxFileBytes,
    });

    // Pre-credit what the server already holds, so a resume starts at its real
    // percentage instead of 0.
    const missing = new Set(begun.missingParts);
    for (let index = 1; index <= partCount; index += 1) {
      if (!missing.has(index)) {
        settled.add(index);
        sentByPart.set(index, sliceFor(index).size);
      }
    }
    phase = 'uploading';
    report();

    const queue = [...begun.missingParts];
    let failure: unknown = null;

    async function worker(slot: number): Promise<void> {
      for (;;) {
        // The slot check is what makes a 429 actually reduce concurrency: a worker
        // whose slot is no longer allowed finishes its current part and stops.
        if (failure || controller.signal.aborted || slot >= concurrency) return;
        const index = queue.shift();
        if (index === undefined) return;
        try {
          if ((await uploadOne(index, slot)) === 'requeue') {
            queue.unshift(index); // the remaining worker takes it next
            return;
          }
        } catch (err) {
          failure ??= err;
          return;
        }
      }
    }

    // Rounds, not one pass: a part can be requeued after the surviving worker has
    // already found the queue empty and stopped. Without another round that part
    // would never be sent and `complete` would fail as INCOMPLETE. Terminates:
    // once concurrency is 1, slot 0 can never be withdrawn, so nothing requeues.
    while (queue.length > 0 && !failure && !controller.signal.aborted) {
      await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot)));
    }
    if (failure) throw failure;
    if (controller.signal.aborted) throw new UploadClientError('Paused.', 0, 'PAUSED');

    phase = 'assembling';
    report();
    const finished = await control<UploadResult>('POST', `/${encodeURIComponent(uploadId)}/complete`, {});
    if (!finished) throw new UploadClientError('The server did not return a result.', 0);
    phase = 'done';
    report();
    return finished;
  }

  const promise = run();
  // Callers that only use pause()/discard() must not see an unhandled rejection.
  promise.catch(() => undefined);

  return {
    promise,
    get uploadId() {
      return uploadId;
    },
    pause: () => controller.abort(),
    discard: async () => {
      controller.abort();
      if (uploadId) await control('DELETE', `/${encodeURIComponent(uploadId)}`).catch(() => undefined);
    },
  };
}
