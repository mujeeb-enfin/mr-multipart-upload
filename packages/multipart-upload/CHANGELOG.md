# Changelog

## 0.1.0

First release.

- Next.js App Router route handlers from a single `createUploadRoutes()` call, mounted on one optional catch-all route.
- Browser client (`startUpload`) and React hook (`useMultipartUpload`) with pause, resume and discard.
- Resume derived entirely from the filesystem — no database, no stored tokens.
- Configuration from `.env`, including `MULTIPART_UPLOAD_MAX_FILE_BYTES`, validated strictly.
- Per-user namespaces, required `authorize`, per-user deduplication.
- Request body limits enforced in the route, including when `Content-Length` is missing or wrong.
- `validateHead` and `onComplete` hooks; configurable `destination`.
- Stale-lock takeover and opportunistic cleanup of abandoned uploads.
- `StorageAdapter` interface with a filesystem implementation (interface experimental).
- Part files are tagged with a hash of the file's fingerprint, so a part from a discarded upload can never be assembled into a later file with the same name.
- The fingerprint samples the first and last 64 KB of the file, so files sharing name, size and modification time are still told apart. `fingerprintFor()` is async.
- Each part carries a SHA-256 (`x-part-sha256`) that the server verifies before writing; a mismatch is a retryable `PART_CHECKSUM_MISMATCH`, never a corrupted file. Parts are sent as `ArrayBuffer`s, not `Blob`s, after a WebKit build was found sending wrong bytes for sliced Blobs.
- Discarding an upload while parts are still arriving no longer fails with a 500 (`ENOTEMPTY` on Windows): directory removal retries when a late part lands mid-delete.
