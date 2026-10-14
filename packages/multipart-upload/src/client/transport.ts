// ---------------------------------------------------------------------------
// transport.ts — how one part reaches the server
// ---------------------------------------------------------------------------
//
// XMLHttpRequest by default, because `fetch` has no upload-progress event: with
// fetch, a 400 MB upload would show a bar that jumps one part at a time.
//
// `fetchPartSender` exists for environments without XHR (server-side tests,
// workers). It reports progress only when a part finishes.
//
// A sender RESOLVES with any HTTP response, error statuses included, and REJECTS
// only when no response arrived (status 0) or the request was aborted. The
// uploader classifies statuses; the sender just reports them.
//
// THE BODY IS AN ArrayBuffer, NOT A Blob. In testing, a WebKit build sent the
// wrong bytes for a sliced Blob: every part went out containing part 1, at the
// correct length, so every size check passed and the upload "succeeded" with a
// corrupted file. Reading the slice into an ArrayBuffer and sending that was
// correct in Chromium, Firefox and WebKit alike. The cost is the parts in flight
// held in memory — 4 x 2 MiB by default.
// ---------------------------------------------------------------------------

import { UploadClientError } from './errors.js';

export interface PartRequest {
  readonly url: string;
  /** The part's bytes, already read from the file. Never a Blob — see above. */
  readonly body: ArrayBuffer;
  readonly headers: Record<string, string>;
  readonly credentials: RequestCredentials;
  readonly signal: AbortSignal;
  /** Bytes of THIS part sent so far. */
  readonly onProgress: (loaded: number) => void;
}

export interface PartResponse {
  readonly status: number;
  readonly body: unknown;
  /** From a Retry-After header, in seconds. */
  readonly retryAfterSeconds: number | null;
}

export type PartSender = (request: PartRequest) => Promise<PartResponse>;

function pausedError(): UploadClientError {
  return new UploadClientError('Paused.', 0, 'PAUSED');
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export const xhrPartSender: PartSender = (request) =>
  new Promise<PartResponse>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(pausedError());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', request.url);
    xhr.withCredentials = request.credentials === 'include';
    for (const [key, value] of Object.entries(request.headers)) xhr.setRequestHeader(key, value);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) request.onProgress(e.loaded);
    });
    xhr.addEventListener('load', () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body, retryAfterSeconds: parseRetryAfter(xhr.getResponseHeader('retry-after')) });
    });
    xhr.addEventListener('error', () =>
      reject(new UploadClientError('The part could not reach the server.', 0, 'NETWORK')),
    );
    xhr.addEventListener('abort', () => reject(pausedError()));
    request.signal.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(request.body);
  });

/** A sender built on fetch, for environments without XMLHttpRequest. */
export function fetchPartSender(fetchImpl: typeof fetch = fetch): PartSender {
  return async (request) => {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: 'PUT',
        body: request.body,
        headers: request.headers,
        credentials: request.credentials,
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal.aborted) throw pausedError();
      throw new UploadClientError(
        err instanceof Error ? err.message : 'The part could not reach the server.',
        0,
        'NETWORK',
      );
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (response.ok) request.onProgress(request.body.byteLength);
    return { status: response.status, body, retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')) };
  };
}
