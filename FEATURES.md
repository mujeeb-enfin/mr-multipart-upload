# Features

`multipart-upload` is a TypeScript library for resumable uploads in Next.js App Router applications. It includes HTTP route handlers, a browser upload engine, a React hook, and a filesystem storage backend.

## Uploads

- Splits files into configurable parts and uploads parts concurrently.
- Resumes interrupted uploads by discovering verified parts on the server; no database, browser token, or persisted client state is required.
- Pauses without deleting uploaded parts, resumes the most recently selected file, and supports explicit discard.
- Retries retryable network and HTTP failures with exponential backoff and `Retry-After` handling; reduces concurrency after HTTP 429 responses.
- Reports monotonic progress and reserves 100% for successful server-side assembly.
- Rejects empty files and files above the configured size limit before part transfer.

## Server and storage

- Exposes `createUploadRoutes()` for Next.js App Router handlers and `createUploader()` for framework-free integrations.
- Requires caller authorization by default and isolates sessions and default deduplication by caller namespace.
- Stores manifests and parts in the filesystem by default; provides an experimental `StorageAdapter` interface for alternate backends.
- Validates part identity, index, and exact byte length; uses exclusive writes and completion locks to protect concurrent operations.
- Streams parts into the assembled file while calculating its SHA-256 hash, and verifies the assembled size against the manifest.
- Supports configurable destination selection, file-header validation, and an `onComplete` callback for application integration.
- Cleans up stale unfinished sessions opportunistically on begin, with an explicit `sweep()` operation for scheduled cleanup.
- Enforces request-body limits and caps metadata size.

## Integrations and configuration

- Browser API: `startUpload()` from `multipart-upload/client`.
- React API: `useMultipartUpload()` from `multipart-upload/react`.
- Server API: `createUploadRoutes()` and `createUploader()` from `multipart-upload/server`.
- Configurable maximum file size, part size, storage directory, unfinished-upload TTL, and instance identifier through environment variables or code options.
- Zero runtime dependencies; requires Node.js 20.9+ and is ESM-only.

## Known constraints

- The built-in filesystem backend requires persistent writable storage and the Node.js runtime; uploads across instances require storage that is shared and reachable by those instances.
- The client fingerprint samples the first and last 64 KiB rather than hashing the entire file. Files with matching name, size, modification time, and sampled bytes but different unsampled contents can collide; the server still computes a full SHA-256 for the assembled result.
- `StorageAdapter` is experimental and may change before 1.0.
