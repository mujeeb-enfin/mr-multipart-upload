# Changelog

## 0.3.1

### Changed

- **Throttling recovers.** After a 429 (or a storage 503) the upload still drops to one part at a time, then earns concurrency back once the requested backoff has passed: one more part at once after each run of `max(2, current)` successes, up to `concurrency`. Previously it stayed at one part for the rest of the upload. `UploadProgress` gains `concurrency`, the current limit; `phase` stays `'throttled'` until it is back at the maximum.

### Fixed

- **Two requests can no longer both take over an abandoned complete lock.** Taking over used to delete the stale lock and create it again — two steps that two takers could interleave, the second deleting the first one's fresh lock. Locks are now generations (`completing.<n>.lock`) and a takeover creates the next one exclusively, so exactly one wins; each lock also carries its holder's token, so a reused generation number never fools a stalled holder. The holder refreshes the lock between long steps (including during Azure's copy) and confirms it still holds it before every irreversible step — publishing, committing, recording, and cleaning up — so a request that stalled past `lockStaleMs` stops instead of committing, running `onComplete` again, or deleting what the request that took over is using. Each holder assembles into its own staging file. Locks written by 0.3.0 are honoured; do not run 0.3.0 and 0.3.1 side by side (0.3.0 does not see the new locks).
- **Commits onto a taken key are refused atomically.** The cloud commit is conditional — `If-None-Match: *` on S3 / MinIO `CompleteMultipartUpload`, a destination condition on Azure's `Put Block List` and copy — so two uploads committing onto one key at the same moment cannot both store; the early existence check remains for a friendly error. Local storage publishes with a hard link, which refuses an existing target, instead of a replacing rename.
- **"This object is our own commit" is proved, not guessed** (`holdsOwnCommit`): every S3 / MinIO multipart upload is stamped with a random session tag (object metadata `x-amz-meta-mpusession`) that S3 gives only to the object that upload's completion creates — so an object another upload wrote at the key, even after a lifecycle rule aborted this one, is never claimed or deleted (sessions started on 0.3.0 have no tag and keep the earlier evidence: no parts left and an object at the key); an Azure blob's committed blocks carry the session's tag; an Azure staged copy records the session's staging blob as its source. Recovery, discard and the sweep use it, so none can claim or delete another upload's object at a shared key. A commit whose response was lost — the SDK's retry then refused as a taken key — is recognised as the upload's own and finishes, instead of stranding it.
- **Azure copy:** a copy of this session's still running is awaited rather than restarted; a staging blob rewritten during the commit is reported as such, not as a taken key; the lock heartbeat runs one refresh at a time, at most every 30 s, and finishes before the commit returns.
- **Client:** `concurrency` is used as a whole number (2.5 → 2); with `concurrency: 1` the phase returns to `'uploading'` after a throttle; only parts started after a throttle count toward recovery; the backoff hold uses a monotonic clock; once a part has failed for good, the other parts stop retrying.
- **Azure: uploads sharing a blob no longer mix blocks.** Azure keeps uncommitted blocks per blob, so two uploads given the same key by a custom `destination()` could each list — and commit — the other's blocks, storing a file spliced from both. Every block id now carries a per-session tag, and each session lists only its own. Sessions started before 0.3.1 keep untagged ids and resume unchanged.
- **Azure proxy transfer: discard and the sweep no longer delete the blob.** Between "no stored file here yet" and the delete, another upload given the same key could commit its file there, and the delete destroyed it. The session's uncommitted blocks are left to Azure's own cleanup (about 7 days); their tag keeps every later session from using them.
- **Local storage, custom `destination()`:** a key already taken is refused with `DESTINATION_EXISTS` instead of being reported `deduplicated` — the upload was handed another upload's file, and its `onComplete` recorded it.
- **Local storage, failing `onComplete`:** a file at the default content-addressed key is no longer removed. Another upload of the same bytes may already have found and recorded it, and removing it lost that record's file. At a custom `destination()` it is still removed, and only while the request still holds the lock.
- **S3-compatible stores without conditional writes:** a commit rejected as not implemented (501 / `NotImplemented`) is retried without `If-None-Match`, instead of failing the upload.
- **S3: a commit cancelled by a concurrent write** (409 `ConditionalRequestConflict`, which drops the multipart upload) starts a fresh provider session for the upload instead of failing for good.
- A staging name that cannot be removed after a local publish (a virus scanner holding it on Windows) no longer fails a `complete` whose file is already stored; cleanup and the sweep remove it.

## 0.3.0

### Added

- **Cloud storage backends**, selected with `storage` (or `MULTIPART_UPLOAD_STORAGE`): `local` (default), `aws_s3`, `minio` and `azure_blob`. Each uses the provider's native multipart API (S3 `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload`; Azure `Put Block` / `Put Block List`); resume, pause, discard, `allowedTypes`, per-user isolation and the sweep work on all four.
  - `aws_s3`: an IAM user's keys, or no keys at all — the AWS SDK default chain (instance profile, ECS task role, EKS, Lambda, SSO, profiles). S3-compatible services through `endpoint`.
  - `minio`: endpoint, bucket and the MinIO user's keys; path-style addressing.
  - `azure_blob`: connection string, account key, SAS token, or Microsoft Entra ID (`DefaultAzureCredential`).
- **Direct transfer** (`transfer: 'direct'`): the browser sends parts straight to S3 / MinIO / Azure with short-lived signed URLs from `POST /api/uploads/:id/parts/:n/url`. S3 URLs sign the part's SHA-256 and exact length; Azure SAS URLs are write-only for one per-session staging blob, with an MD5 Azure verifies, and the server copies that blob to the final key at `complete` — an Azure write SAS also allows replacing a whole blob, so it never names the stored file. The client follows the server's mode automatically and fetches a fresh URL per attempt; it retries a storage 400/403 with a fresh URL, treats a storage 503 as throttling, and does not retry a 400/403 from the app's own signing request.
- Cloud storage keys are unique per upload session (`files/<user hash>/<uploadId>-<sessionId>.<ext>`), fixed at begin and kept through pause, reload and resume. `destination()` receives `sessionId`. A commit onto an object the upload did not create is refused with the new `DESTINATION_EXISTS` (409), so a custom `destination()` that is not unique cannot overwrite — or later delete — another upload's file.
- `checksum` on the stored file and the client's result: the exact `sha256` (local), or `sha256-composite` — SHA-256 of every part's SHA-256, S3's definition — for cloud storage.
- Every cloud setting is validated before any byte is stored (on the first request that uses it) and named in errors (part size ≥ 5 MiB for S3, the providers' part-count limits, direct transfer's preconditions); no secret appears in any message.
- The cloud SDKs are optional peer dependencies — not installed with this package; install the ones your storage needs (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@azure/storage-blob`, `@azure/identity`). A missing one is reported with the command to install it.
- Crash safety for cloud commits: a `complete` that stops between the provider's commit and recording it is finished by the next `complete` (reported with `checksum: null`, since the composite cannot be recomputed), and discard or the sweep removes the file it left. A marker written before each commit tells such a file apart from any object this upload did not create, which is never claimed or deleted. If deleting a refused file fails, its session is kept so a retry, discard or the sweep still removes it, and the refusal says so (`details.refusedFileKept`). A reload after the commit resumes with no parts to send, so the browser goes straight to `complete`. After a successful `complete` (and on discard) the manifest is removed first, so no later discard or sweep can delete a file the app has recorded.
- Azure direct transfer: the copy to the final key is conditional on the exact staging blob committed (a replaced one fails instead of being stored), the stored file's content type is reset to the server's, the copy is given 10 minutes and aborted after that, and signed URLs never outlive the Entra ID key that signs them.

### Fixed

- A pause that landed after a part was accepted but before its response body was read ended the upload with `NETWORK` instead of pausing it.
- `discard` now takes the `complete` lock instead of only checking for it, so a `complete` starting during a discard is refused rather than racing it (local and cloud storage).

### Security

- With proxy transfer the content check runs before the file exists, on the first bytes of part 1 — kept bound to that part's SHA-256, so two concurrent sends of part 1 with different bytes cannot get one version approved and the other stored.

## 0.2.0

### Added

- **`allowedTypes`** — restrict uploads by file type, as a parameter or `MULTIPART_UPLOAD_ALLOWED_TYPES` (comma-separated). Entries use the HTML `accept` syntax: `'image/png'`, `'image/*'`, `'.zip'`. Checked twice: by declared type and extension when the upload starts (refused before any byte is sent), and by the file's **actual content** before it is stored, so a renamed executable is refused. New error code `FILE_TYPE_NOT_ALLOWED` (415).
- Content signatures for 30+ formats — images, PDF, Office, archives, audio, video and executables — exported as `detectFileType()`.
- **`FILE_TYPES`** presets (`images`, `documents`, `pdf`, `spreadsheets`, `audio`, `video`, `archives`, …), exported from `/server` and `/client`.
- `contentType` on the stored file (`onComplete`'s `file.contentType`) and on the client's result: the type verified from the content where the format has a signature.
- `GET /api/uploads` returns `allowedTypes`, ready for `<input accept>`.
- The client sends the browser's `File.type` when an upload begins.
- README: a complete integration example, every setting with its `.env` fallback, the messages users see, a MIME type reference, and upgrade notes. Repository, homepage and issue links in `package.json`.

### Changed

- **Upload ids are now the SHA-256 of the file name, size, MIME type and content fingerprint** (64 hex characters), and name each upload's temporary folder. A file differing in any of these gets its own folder and can never share parts with another. File names no longer appear in folder names, and names with no Latin letters (`写真.png`) are accepted.
- Two different files with the same name are now two separate uploads. Previously the second was refused with `NAME_IN_USE`; that code now means a stored manifest no longer matches its id.
- Resuming after `partBytes` was changed continues on the part size frozen in the manifest instead of being refused.
- `INVALID_NAME` now means the file name contains a control character.

### Upgrading

Unfinished uploads started on 0.1.x cannot be resumed after upgrading: the same file starts a new upload, and the sweep removes the old folders after `partTtlMs`. Finished files are unaffected.

## 0.1.0

First release.

- Next.js App Router route handlers from a single `createUploadRoutes()` call, mounted on one optional catch-all route.
- Browser client (`startUpload`) and React hook (`useMultipartUpload`) with pause, resume and discard.
- Resume derived entirely from the filesystem — no database, no stored tokens.
- Configuration from `.env`, including `MULTIPART_UPLOAD_MAX_FILE_BYTES` (default 500 MiB), validated strictly.
- A refused oversized file is described in readable sizes, with the exact byte counts kept: "This file is 181 MB (189,963,874 bytes); the maximum upload size is 40 MB (41,943,040 bytes)."
- Per-user namespaces, required `authorize`, per-user deduplication.
- Request body limits enforced in the route, including when `Content-Length` is missing or wrong.
- `validateHead` and `onComplete` hooks; configurable `destination`.
- Stale-lock takeover and opportunistic cleanup of abandoned uploads.
- `StorageAdapter` interface with a filesystem implementation (interface experimental).
- Part files are tagged with a hash of the file's fingerprint, so a part from a discarded upload can never be assembled into a later file with the same name.
- The fingerprint samples the first and last 64 KB of the file, so files sharing name, size and modification time are still told apart. `fingerprintFor()` is async.
- Each part carries a SHA-256 (`x-part-sha256`) that the server verifies before writing; a mismatch is a retryable `PART_CHECKSUM_MISMATCH`, never a corrupted file. Parts are sent as `ArrayBuffer`s, not `Blob`s, after a WebKit build was found sending wrong bytes for sliced Blobs.
- Discarding an upload while parts are still arriving no longer fails with a 500 (`ENOTEMPTY` on Windows): directory removal retries when a late part lands mid-delete.
