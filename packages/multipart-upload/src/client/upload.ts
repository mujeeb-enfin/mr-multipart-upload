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
// THROTTLING ACTUALLY THROTTLES — AND RECOVERS. On a 429 (or a storage 503) the
// upload drops to one part at a time, then earns concurrency back one part at a
// time after runs of successes, up to the configured `concurrency`; another
// throttle signal drops it to one again. The original implementation set `concurrency = 1` but
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
import { md5Base64 } from './md5.js';
import { xhrPartSender } from './transport.js';
import { backoffFor, delay, errorFrom, sha256Hex } from './upload-helpers.js';
import type { StartUploadOptions, UploadHandle, UploadPhase, UploadResult, UploadStartInfo } from './upload-types.js';

export const FINGERPRINT_HEADER = 'x-upload-fingerprint';
/** Lowercase hex SHA-256 of a part, verified by the server before it is written. */
export const PART_CHECKSUM_HEADER = 'x-part-sha256';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 5;

export type {
  HeadersOption,
  StartUploadOptions,
  UploadChecksum,
  UploadHandle,
  UploadPhase,
  UploadProgress,
  UploadResult,
  UploadStartInfo,
} from './upload-types.js';

export function startUpload(options: StartUploadOptions): UploadHandle {
  const { file, onProgress } = options;
  const endpoint = (options.endpoint ?? '/api/uploads').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const sendPart = options.sendPart ?? xhrPartSender;
  const credentials = options.credentials ?? 'same-origin';
  // A whole number of at least 1, so the retry limit is always reached.
  const requestedAttempts = Math.floor(options.maxAttemptsPerPart ?? DEFAULT_MAX_ATTEMPTS);
  const maxAttempts = Number.isFinite(requestedAttempts) ? Math.max(1, requestedAttempts) : DEFAULT_MAX_ATTEMPTS;
  // Computed at the start of run(): it reads two small samples of the file.
  let fingerprint = '';
  const controller = new AbortController();

  let uploadId: string | null = null;
  // A whole number of at least 1: a fractional limit would let the slot loop run
  // one more worker than configured, and NaN none at all.
  // (Infinity stays Infinity — "no limit" — and is capped at the part count.)
  const requestedConcurrency = Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxConcurrency = Number.isNaN(requestedConcurrency) ? DEFAULT_CONCURRENCY : Math.max(1, requestedConcurrency);
  let concurrency = maxConcurrency;
  // Successes since concurrency last changed; drives the additive increase.
  let successStreak = 0;
  // Until when (performance.now() ms, a monotonic clock) successes do not count
  // toward recovery: the backoff the last throttle signal asked for. Ramping up
  // while the limiter is still saying "wait" would put the throttled part back
  // alongside others.
  let rampHoldUntil = 0;
  // Counts throttle signals. A part that STARTED before the latest one says
  // nothing about whether the limiter has recovered, so its success does not count.
  let throttleEpoch = 0;
  // Set when a part has failed for good: the other workers stop retrying theirs,
  // and any of them waiting out a backoff is woken (not a pause: no PAUSED).
  let abandoned = false;
  const abandon = new AbortController();
  // Set by run(): starts a worker for every slot the limit now allows.
  let startWorkers: () => void = () => undefined;
  let phase: UploadPhase = 'starting';
  let partBytes = 0;
  let partCount = 0;
  // Set from the server's `begin` answer: how THIS server receives parts.
  let transfer: 'proxy' | 'direct' = 'proxy';
  let directChecksums: readonly string[] = [];
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
    onProgress({ percent, sentBytes, totalBytes: file.size, partsDone: settled.size, partsTotal: partCount, phase, concurrency });
  }

  /**
   * A JSON control request. `abortable: false` for requests that must finish even
   * after pause/discard: `begin` (see below) and the discard's own DELETE.
   */
  async function control<T>(method: string, path: string, body?: unknown, abortable = true): Promise<T | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method,
        credentials,
        signal: abortable ? controller.signal : undefined,
        headers: await headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (abortable && controller.signal.aborted) throw new UploadClientError('Paused.', 0, 'PAUSED');
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
   * Additive increase after throttling: one more part at once after each run of
   * `max(2, concurrency)` successes — about one "window" of parts going through
   * cleanly — up to the configured concurrency. A success counts only when its
   * part started after the latest throttle signal (`startedInEpoch`) and the
   * backoff that signal asked for has passed; a throttle signal resets the
   * count (see uploadOne), so an upload that keeps being limited stays slow.
   */
  function recordSuccess(startedInEpoch: number): void {
    if (startedInEpoch !== throttleEpoch || performance.now() < rampHoldUntil) return;
    if (concurrency < maxConcurrency) {
      successStreak += 1;
      if (successStreak < Math.max(2, concurrency)) return;
      concurrency += 1;
      successStreak = 0;
      startWorkers();
    }
    // Back at the configured limit — immediately so when that limit is 1.
    if (concurrency === maxConcurrency && phase === 'throttled') phase = 'uploading';
  }

  /**
   * Upload one part, retrying on retryable failures.
   * @returns 'done', or 'requeue' when this worker's slot was withdrawn by a 429
   *   and the part must be retried by the remaining worker instead.
   */
  async function uploadOne(index: number, slot: number): Promise<'done' | 'requeue'> {
    // Read once, hash once, and send exactly the bytes that were hashed — reused
    // across retries. See transport.ts for why this is an ArrayBuffer.
    const body = await sliceFor(index).arrayBuffer();
    const checksum = await sha256Hex(body);
    const direct = transfer === 'direct';
    if (direct && !checksum) {
      // The storage verifies each part against the SHA-256 signed into its URL;
      // without one the part cannot be sent safely.
      throw new UploadClientError('Direct uploads need a secure context (HTTPS or localhost) to compute part checksums.', 0, 'INSECURE_CONTEXT');
    }
    const md5 = direct && directChecksums.includes('md5') ? md5Base64(body) : undefined;
    const partHeaders: Record<string, string> = {
      'content-type': 'application/octet-stream',
      [FINGERPRINT_HEADER]: fingerprint,
      ...(checksum ? { [PART_CHECKSUM_HEADER]: checksum } : {}),
    };
    const onPartProgress = (loaded: number) => {
      if (settled.has(index)) return;
      sentByPart.set(index, loaded);
      report();
    };
    for (;;) {
      if (controller.signal.aborted) throw new UploadClientError('Paused.', 0, 'PAUSED');
      // Re-checked before EVERY attempt, the first included: a throttle that
      // arrived while this part was being read and hashed has withdrawn the slot.
      if (slot >= concurrency) return 'requeue';
      const attempt = (attemptsByPart.get(index) ?? 0) + 1;
      attemptsByPart.set(index, attempt);
      // Another part failed for good: the upload is over, so no more attempts
      // (the upload ends with that part's error, not this one).
      if (abandoned) throw new UploadClientError('Stopped: another part failed.', 0);
      const startedInEpoch = throttleEpoch;
      // Direct transfer: whether this attempt reached the STORAGE — a failure
      // before that came from the app's own server (the signing request).
      let reachedStorage = false;
      const response = await (async () => {
        if (!direct) {
          return sendPart({
            url: `${endpoint}/${encodeURIComponent(uploadId as string)}/parts/${index}`,
            body,
            credentials,
            signal: controller.signal,
            headers: await headers(partHeaders),
            onProgress: onPartProgress,
          });
        }
        // A fresh signed request per attempt, so a retry never carries a URL
        // that expired during the backoff. Sent straight to the storage, with
        // only the signed headers and no cookies.
        const signed = await control<{ url: string; headers: Record<string, string> }>(
          'POST',
          `/${encodeURIComponent(uploadId as string)}/parts/${index}/url`,
          { fingerprint, sha256: checksum, ...(md5 ? { md5 } : {}) },
        );
        if (!signed) throw new UploadClientError('The server did not sign the part.', 0);
        reachedStorage = true;
        return sendPart({ url: signed.url, body, credentials: 'omit', signal: controller.signal, headers: signed.headers, onProgress: onPartProgress });
      })().catch((err: unknown) => {
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
        sentByPart.set(index, body.byteLength); // pinned: never written again
        recordSuccess(startedInEpoch);
        report();
        return 'done';
      }
      // Credit nothing for a failed attempt, so the bar does not sit at a number
      // this part never reached.
      sentByPart.delete(index);
      // Once paused, any failure is the pause: a part cut off by it must not end
      // the upload as an error the user did not cause.
      if (controller.signal.aborted) throw new UploadClientError('Paused.', 0, 'PAUSED');
      if (failure.code === 'PAUSED') throw failure;
      // Direct transfer: the STORAGE answers 403 for an expired or skewed
      // signature and 400 for bytes that failed its checksum — both cured by a
      // fresh URL and a resend, within the attempt limit. The same statuses from
      // the app's own server (the signing request) are final, as everywhere else.
      const retryableDirect = reachedStorage && !failure.code && (failure.status === 400 || failure.status === 403);
      if ((!retryableDirect && !isRetryable(failure.status, failure.code)) || attempt >= maxAttempts) throw failure;

      const wait = backoffFor(attempt, (failure as { retryAfterSeconds?: number | null }).retryAfterSeconds ?? null);
      // S3 throttles with 503 SlowDown and Azure with 503 ServerBusy, not 429.
      if (failure.status === 429 || (reachedStorage && failure.status === 503)) {
        // Down to one part at once: the limiter gets real relief, and the
        // remaining worker takes this part next (see the file header).
        concurrency = 1;
        successStreak = 0;
        throttleEpoch += 1;
        rampHoldUntil = Math.max(rampHoldUntil, performance.now() + wait);
        phase = 'throttled';
      }
      report();
      // The loop's first check runs again after the backoff: another worker's
      // 429 may have withdrawn this slot while it waited.
      await delay(wait, controller.signal, abandon.signal);
    }
  }

  // `begin` is NOT abortable. The server may create the upload before the client
  // hears back; aborting would leave the client without its id, so a discard
  // could not delete it and the "discarded" upload would linger until the sweep.
  // `begin` takes milliseconds, so letting it finish costs nothing, and
  // `discard()` waits on this before deleting.
  let beginSettled: Promise<unknown> = Promise.resolve();

  async function run(): Promise<UploadResult> {
    fingerprint = await fingerprintFor(file);
    // Paused or discarded while the file was being sampled: never send begin.
    // From here to `beginSettled` below is synchronous, so a discard either
    // happened before this check (begin is not sent) or after (it waits for it).
    if (controller.signal.aborted) throw new UploadClientError('Paused.', 0, 'PAUSED');
    const beginRequest = control<UploadStartInfo & { missingParts: number[]; directChecksums?: string[] }>(
      'POST',
      '',
      // contentType lets the server refuse a disallowed type before any part is
      // sent. It is only the browser's guess from the name; the server also
      // checks the real content before storing the file.
      { fileName: file.name, totalBytes: file.size, fingerprint, metadata: options.metadata ?? {}, contentType: file.type },
      false,
    );
    beginSettled = beginRequest.catch(() => undefined);
    const begun = await beginRequest;
    if (!begun) throw new UploadClientError('The server did not start the upload.', 0);

    uploadId = begun.uploadId;
    if (controller.signal.aborted) throw new UploadClientError('Paused.', 0, 'PAUSED');
    partBytes = begun.partBytes;
    partCount = begun.partCount;
    transfer = begun.transfer === 'direct' ? 'direct' : 'proxy';
    directChecksums = begun.directChecksums ?? [];
    options.onStart?.({
      uploadId: begun.uploadId,
      partCount,
      partBytes,
      receivedBytes: begun.receivedBytes,
      resumed: begun.receivedBytes > 0,
      maxFileBytes: begun.maxFileBytes,
      transfer,
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
          abandoned = true;
          abandon.abort();
          return;
        }
      }
    }

    // A pool, not a fixed set: a worker is started for every slot the limit
    // allows — at the start, whenever the limit rises again after throttling,
    // and after any worker stops (a part it requeued may need a worker: the
    // others may have found the queue empty already, and without one that part
    // would never be sent and `complete` would fail as INCOMPLETE). Terminates:
    // workers only start while parts are queued, and a requeue never comes from
    // slot 0, which a lower limit can never withdraw.
    const activeSlots = new Set<number>();
    const running = new Set<Promise<void>>();
    startWorkers = () => {
      // No more workers than parts: also what makes `concurrency: Infinity` work.
      const limit = Math.min(concurrency, partCount);
      for (let slot = 0; slot < limit; slot += 1) {
        if (queue.length === 0 || failure || controller.signal.aborted) break;
        if (activeSlots.has(slot)) continue;
        activeSlots.add(slot);
        const job: Promise<void> = worker(slot).finally(() => {
          activeSlots.delete(slot);
          running.delete(job);
        });
        running.add(job);
      }
    };
    startWorkers();
    while (running.size > 0) {
      await Promise.race(running);
      startWorkers();
    }
    startWorkers = () => undefined;
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
      // If begin is still in flight, wait for it: only then is the id known.
      await beginSettled;
      if (uploadId) await control('DELETE', `/${encodeURIComponent(uploadId)}`, undefined, false).catch(() => undefined);
    },
  };
}
