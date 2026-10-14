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
