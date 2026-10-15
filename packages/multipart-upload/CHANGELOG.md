# Changelog

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
