# Changelog

## 0.3.0

### Added

- **Cloud storage backends**, selected with `storage` (or `MULTIPART_UPLOAD_STORAGE`): `local` (default), `aws_s3`, `minio` and `azure_blob`. Each uses the provider's native multipart API (S3 `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload`; Azure `Put Block` / `Put Block List`); resume, pause, discard, `allowedTypes`, per-user isolation and the sweep work on all four.
  - `aws_s3`: an IAM user's keys, or no keys at all — the AWS SDK default chain (instance profile, ECS task role, EKS, Lambda, SSO, profiles). S3-compatible services through `endpoint`.
  - `minio`: endpoint, bucket and the MinIO user's keys; path-style addressing.
  - `azure_blob`: connection string, account key, SAS token, or Microsoft Entra ID (`DefaultAzureCredential`).
- **Direct transfer** (`transfer: 'direct'`): the browser sends parts straight to S3 / MinIO / Azure with short-lived signed URLs from `POST /api/uploads/:id/parts/:n/url`. S3 URLs sign the part's SHA-256 and exact length; Azure SAS URLs are write-only for one per-session staging blob, with an MD5 Azure verifies, and the server copies that blob to the final key at `complete` — an Azure write SAS also allows replacing a whole blob, so it never names the stored file. The client follows the server's mode automatically and fetches a fresh URL per attempt; it retries a storage 400/403 with a fresh URL, treats a storage 503 as throttling, and does not retry a 400/403 from the app's own signing request.
- Cloud storage keys are unique per upload session (`files/<user hash>/<uploadId>-<sessionId>.<ext>`), fixed at begin and kept through pause, reload and resume. `destination()` receives `sessionId`. A commit onto an object the upload did not create is refused with the new `DESTINATION_EXISTS` (409), so a custom `destination()` that is not unique cannot overwrite — or later delete — another upload's file.
- `checksum` on the stored file and the client's result: the exact `sha256` (local), or `sha256-composite` — SHA-256 of every part's SHA-256, S3's definition — for cloud storage.
- Every cloud setting is validated at startup and named in errors (part size ≥ 5 MiB for S3, the providers' part-count limits, direct transfer's preconditions); no secret appears in any message.
- The cloud SDKs are optional peer dependencies; a missing one is reported with the package to install.
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
