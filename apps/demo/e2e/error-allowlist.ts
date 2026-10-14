// ---------------------------------------------------------------------------
// error-allowlist.ts — the ONLY place an e2e test may declare expected errors
// ---------------------------------------------------------------------------
//
// The shared fixture (test.ts) fails any test that produces a browser console
// error, an uncaught page error, a network response >= 400, a failed request,
// or a server log error. Negative-path tests provoke some of those ON PURPOSE;
// each such test is listed here, by its exact title, with the specific errors it
// expects and why. Anything not listed still fails the test.
//
// CODER.md asks for a linked ticket per entry. This repository has no issue
// tracker yet, so each entry carries its reason instead; add the ticket link
// when one exists.
// ---------------------------------------------------------------------------

export interface AllowedErrors {
  /** Why these errors are expected. Required: nothing is suppressed silently. */
  readonly reason: string;
  /** HTTP statuses the test provokes on purpose. */
  readonly statuses?: readonly number[];
  /** Requests the test aborts on purpose (pause, discard), matched on the URL. */
  readonly abortedRequests?: RegExp;
  /** Console messages, beyond "status of NNN" for the statuses above, the test causes. */
  readonly console?: readonly RegExp[];
}

/** Part uploads, which pause and discard abort mid-flight. */
const PART_REQUEST = /\/api\/uploads\/[^/]+\/parts\/\d+$/;

export const ALLOWED_ERRORS: Readonly<Record<string, AllowedErrors>> = {
  'resumes after a pause and a page reload, sending only the missing parts': {
    reason: 'Pausing aborts the part requests in flight; that is the behaviour under test.',
    abortedRequests: PART_REQUEST,
  },
  'recovers from a 429 and a 503 mid-upload, throttling down, with identical bytes stored': {
    reason: 'The test injects one 429 and one 503 to prove the client retries and throttles.',
    statuses: [429, 503],
  },
  'asks for confirmation, and discarding removes everything from the server': {
    reason: 'Discarding aborts the part requests in flight; that is the behaviour under test.',
    abortedRequests: PART_REQUEST,
  },
  'cancelling the discard confirmation keeps the upload': {
    reason: 'The test pauses before discarding, which aborts the part requests in flight.',
    abortedRequests: PART_REQUEST,
  },
  'a different file with the same name is refused, not merged into the first': {
    reason: 'The server must answer 409 NAME_IN_USE; pausing first aborts in-flight parts.',
    statuses: [409],
    abortedRequests: PART_REQUEST,
  },
  'refuses a file over MULTIPART_UPLOAD_MAX_FILE_BYTES without sending any part': {
    reason: 'The server must answer 413 FILE_TOO_LARGE; that is the behaviour under test.',
    statuses: [413],
  },
  'a failed finish is reported, keeps every part, and succeeds on retry': {
    reason: 'The test injects one 500 on the complete request to prove the parts survive it.',
    statuses: [500],
  },
  'shows the error state accessibly': {
    reason: 'Reaching the error state needs a refused upload: the server answers 413.',
    statuses: [413],
  },
  'error state': {
    reason: 'The visual snapshot of the error state needs a refused upload: 413.',
    statuses: [413],
  },
};
