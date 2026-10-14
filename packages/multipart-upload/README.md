# multipart-upload

Resumable multipart file uploads for **Next.js** — App Router route handlers, a browser client and a React hook, in TypeScript.

Large files are sent in parts. If the connection drops, the tab closes or the server restarts, picking the same file again sends **only the parts the server does not already have**.

- **No database.** The filesystem is the state; the server works out what it has by listing a directory.
- **Nothing random.** Every name is derived from the user, the file name, the part number or the file's hash, so a resume needs no token stored anywhere.
- **Byte-exact.** The stored file is hashed as it is written, and its size must equal the declared size or nothing is stored.
- **Isolated per user.** Two users uploading `photo.jpg` never share anything.
- **Configured from `.env`**, including the maximum upload size.
- **Zero runtime dependencies.**

```bash
npm install multipart-upload
```

Requires Node.js 20.9 or later and the Next.js App Router. The package is ESM-only.

---

## Quick start

### 1. The server: one route file

```ts
// app/api/uploads/[[...path]]/route.ts
import { createUploadRoutes } from 'multipart-upload/server';
import { auth } from '@/auth'; // your authentication

export const runtime = 'nodejs';        // the filesystem needs the Node.js runtime
export const dynamic = 'force-dynamic'; // uploads must never be cached

export const { GET, POST, PUT, DELETE } = createUploadRoutes({
  // Who is uploading. Return null to refuse with 401.
  authorize: async () => {
    const session = await auth();
    return session?.user?.id ? { namespace: session.user.id } : null;
  },

  // The file is assembled and stored. Record it; the return value goes to the browser.
  onComplete: async ({ file, metadata, namespace }) => {
    const row = await db.files.create({
      owner: namespace,
      name: file.fileName,
      size: file.size,
      sha256: file.sha256,
      path: file.localPath,
    });
    return { id: row.id };
  },
});
```

The folder name `[[...path]]` matters: it is an optional catch-all, so this single file handles every upload URL.

### 2. The client: a hook in any client component

```tsx
'use client';
import { useMultipartUpload } from 'multipart-upload/react';

export function FileUpload() {
  const upload = useMultipartUpload({ endpoint: '/api/uploads' });

  return (
    <div>
      <input type="file" onChange={(e) => e.target.files?.[0] && upload.start(e.target.files[0])} />
      <progress value={upload.progress?.percent ?? 0} max={100} />
      <button onClick={upload.pause} disabled={upload.status !== 'uploading'}>Pause</button>
      <button onClick={upload.resume} disabled={upload.status !== 'paused'}>Resume</button>
      {upload.startInfo?.resumed && <p>Resuming — only the missing parts will be sent.</p>}
      {upload.error && <p role="alert">{upload.error.message}</p>}
      {upload.result && <p>Stored {upload.result.fileName} ({upload.result.size} bytes)</p>}
    </div>
  );
}
```

That is the whole integration. A complete working app is in [`apps/demo`](../../apps/demo).

---

## Configuration (`.env`)

Every variable is optional.

| Variable | Default | Meaning |
|---|---|---|
| `MULTIPART_UPLOAD_MAX_FILE_BYTES` | `1073741824` (1 GiB) | Largest file accepted, in bytes. |
| `MULTIPART_UPLOAD_PART_BYTES` | `2097152` (2 MiB) | Bytes per part, between 1 MiB and 8 MiB. |
| `MULTIPART_UPLOAD_DIR` | `./uploads` | Where parts and finished files are stored. |
| `MULTIPART_UPLOAD_PART_TTL_HOURS` | `48` | Unfinished uploads untouched this long are removed. |
| `MULTIPART_UPLOAD_INSTANCE_ID` | `single` | A distinct value per server, if you run more than one. |

- Values are read **on every request**, so a changed value takes effect without code changes.
- Invalid values are **refused, never silently corrected**: `MULTIPART_UPLOAD_MAX_FILE_BYTES=10MB` fails with an error naming the variable. Use whole numbers of bytes.
- The browser learns the limit from the server, so it is configured in one place only. An oversized file is refused before any of it is sent.
- Each setting can be overridden in code: `createUploadRoutes({ maxFileBytes: 50 * 1024 * 1024 })`.

**Reverse proxies:** each part is one request body. Allow at least the part size plus some headroom — with nginx, `client_max_body_size 10m;` covers the 8 MiB maximum.

---

## Server API — `multipart-upload/server`

### `createUploadRoutes(options)`

Returns `{ GET, POST, PUT, DELETE, uploader }`. Export the four handlers from your route file.

| Option | Description |
|---|---|
| `authorize(request)` | **Required.** Return `{ namespace }` — usually the user id — or `null` to refuse with 401. Uploads are isolated per namespace. |
| `allowAnonymous` | Accept uploads with no `authorize`. All anonymous callers share one namespace. Use only deliberately. |
| `onComplete(input)` | Called once the file is stored. Receives `{ file, metadata, namespace, uploadId, deduplicated }`. Its return value is sent to the client as `result`. If it throws, a newly stored file is removed and the parts are kept, so the user can retry. |
| `validateHead(bytes, info)` | Inspect the first bytes of the file (64 KB by default) before it is assembled — for example, check it really is a PDF. Throw to refuse with 422. The parts are kept. |
| `destination(info)` | Choose the storage key of a completed file. Default: `files/<namespace hash>/<sha256>.<ext>`. |
| `basePath` | URL the route is mounted at. Default `/api/uploads`. |
| `maxMetadataBytes` | Largest metadata object accepted. Default 16 KB. |
| `headBytes` | Bytes passed to `validateHead`. Default 64 KB. |
| `sweepOnBegin` | Remove expired unfinished uploads when a new one begins. Default `true`. |
| `lockStaleMs` | A finishing lock older than this is treated as abandoned. Default 15 minutes. |
| `onError(error, request)` | Called for unexpected (500) errors. Default: `console.error`. |
| `storage` | A custom storage backend (see below). |
| `maxFileBytes`, `partBytes`, `dir`, `partTtlMs`, `instanceId` | Override the matching `.env` values. |

The `file` passed to `onComplete`:

```ts
{
  key: string;                 // storage key, relative to MULTIPART_UPLOAD_DIR
  localPath: string | undefined; // absolute path on disk (always set with the built-in filesystem storage)
  size: number;
  sha256: string;              // lowercase hex
  fileName: string;            // the name the user picked
  read(): ReadableStream<Uint8Array>;
}
```

### `createUploader(options)`

The same functionality without HTTP — `begin`, `putPart`, `status`, `list`, `complete`, `discard`, `sweep` — for custom routes or background jobs.

### Cleaning up abandoned uploads

There are no background timers. Expired uploads are removed when a new upload begins (`sweepOnBegin`). To clean up on a schedule as well, create the routes in a shared module so a cron route can reach the same uploader:

```ts
// lib/uploads.ts
import { createUploadRoutes } from 'multipart-upload/server';
export const uploads = createUploadRoutes({ authorize, onComplete });
```

```ts
// app/api/uploads/[[...path]]/route.ts
import { uploads } from '@/lib/uploads';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, DELETE } = uploads;
```

```ts
// app/api/cron/uploads/route.ts — call from your scheduler, protected as you see fit
import { uploads } from '@/lib/uploads';
export const runtime = 'nodejs';
export async function POST() {
  return Response.json(await uploads.uploader.sweep());
}
```

---

## Client API

### `useMultipartUpload(options)` — `multipart-upload/react`

| Returns | |
|---|---|
| `start(file, { metadata })` | Upload a file, or resume it if the server already holds some of its parts. |
| `pause()` | Stop sending. The server keeps the parts. |
| `resume()` | Start the last file again; only its missing parts are sent. |
| `discard()` | Stop and delete the server's parts. |
| `reset()` | Return to idle without touching the server. |
| `status` | `'idle' \| 'uploading' \| 'assembling' \| 'paused' \| 'done' \| 'error'` |
| `progress` | `{ percent, sentBytes, totalBytes, partsDone, partsTotal, phase }` |
| `startInfo` | `{ uploadId, resumed, receivedBytes, maxFileBytes, … }` once the server has answered. |
| `result` | The completed upload, including whatever `onComplete` returned. |
| `error` | An `UploadClientError` with `status`, `code` and `details`. |

Unmounting the component pauses the upload; it never discards it.

### `startUpload(options)` — `multipart-upload/client`

The framework-free engine behind the hook. Returns `{ promise, pause, discard, uploadId }`.

| Option | Default | |
|---|---|---|
| `file` | — | The `File` to upload. |
| `endpoint` | `/api/uploads` | Where the route is mounted. |
| `headers` | — | Extra headers on every request, or a function returning them (for tokens that refresh). |
| `metadata` | `{}` | A JSON object stored with the upload and handed to `onComplete`. |
| `concurrency` | `4` | Parts in flight at once. |
| `maxAttemptsPerPart` | `5` | |
| `onStart`, `onProgress` | — | Callbacks. |

**Retries.** Network errors, 5xx, 408 and 429 are retried with exponential backoff, honouring `Retry-After`. On a 429 the upload drops to one part at a time for the rest of the run. Other 4xx errors are not retried — they would fail the same way again.

**Progress** never goes backwards, and reaches 100% only after the server has assembled the file.

---

## How resume works

1. The browser sends the file's name, size and a **fingerprint** derived from its size, modification time and name.
2. The server derives an upload id from the file name (`Holiday Video.mp4` → `holiday-video-mp4`) and looks for an existing upload with that id in the user's namespace.
3. If one exists **and the fingerprint matches**, the server lists its directory and answers with the part numbers it is missing. If the fingerprint does not match, it is a different file with the same name, and the server refuses with `409 NAME_IN_USE` rather than mixing the two.
4. The browser sends only the missing parts.

On disk:

```
uploads/
  .parts/<namespace hash>/holiday-video-mp4/
    manifest.json
    000001.part … 000200.part
  files/<namespace hash>/<sha256>.mp4
```

A part counts as received only if its size is exactly right, so a part cut off mid-write is re-sent automatically. Parts are created with an exclusive-create flag, so two simultaneous attempts at the same part can never interleave.

---

## Security

- **`authorize` is required.** Omitting it throws when the route module loads, so a misconfiguration fails `next build`, not production.
- **Per-user isolation.** Namespaces are hashed into directory names, so user ids of any form are safe, and one user can never read, resume, complete or discard another's upload.
- **Deduplication is per user.** Identical files from the same user are stored once. It is deliberately not shared across users: a shared store would tell one user, through `deduplicated: true`, that someone else had uploaded the same file. A custom `destination` can change this — knowingly.
- **Size limits are enforced in the route.** A part is refused by its `Content-Length` before it is read, and reading stops at the limit if that header is wrong or missing.
- **Paths are contained.** Upload ids are restricted to lowercase letters, digits and hyphens, and every storage key passes a containment check against the storage directory.
- **The fingerprint is not a secret.** It only tells "the same file again" apart from "a different file with the same name". Access control is `authorize`'s job.

---

## Requirements and limitations

- **A persistent, writable filesystem.** Self-hosted `next start`, Docker or a VPS. Serverless platforms with an ephemeral filesystem, such as Vercel functions, cannot keep parts between requests, so the built-in storage does not work there.
- **One storage location per deployment.** With several servers, all must share `MULTIPART_UPLOAD_DIR`, or requests for one upload must reach the same server. Setting `MULTIPART_UPLOAD_INSTANCE_ID` per server turns a cross-server resume into a clear `409 WRONG_INSTANCE` instead of a corrupted file.
- **ESM only.** Next.js handles this natively.
- **Custom storage backends** implement the `StorageAdapter` interface. It is marked experimental until a second backend exists and may change before 1.0.

---

## Error codes

Every error response is `{ "error": { "code", "message", "details"? } }`.

| Code | Status | Meaning |
|---|---|---|
| `FILE_TOO_LARGE` | 413 | Over `MULTIPART_UPLOAD_MAX_FILE_BYTES`. `details.maxFileBytes` holds the limit. |
| `BODY_TOO_LARGE` | 413 | A request body over its limit. |
| `METADATA_TOO_LARGE` | 413 | Metadata over `maxMetadataBytes`. |
| `NAME_IN_USE` | 409 | A different file with the same name is already uploading. |
| `FINGERPRINT_MISMATCH` | 409 | A part for a different file than the upload in progress. |
| `PART_IN_FLIGHT` | 409 | Another request is writing that part right now. Retried automatically. |
| `COMPLETE_IN_PROGRESS` | 409 | The upload is already being finished. |
| `INCOMPLETE` | 409 | Parts are missing. `details.missingParts` lists them. |
| `WRONG_INSTANCE` | 409 | The upload's parts are on another server. |
| `NO_SESSION` | 404 | No such upload for this user. |
| `PART_LENGTH_MISMATCH` | 400 | A part of the wrong size. |
| `PART_OUT_OF_RANGE` | 400 | A part number outside the upload. |
| `INVALID_NAME` | 400 | The file name has no Latin letter or digit to build an id from. |
| `INVALID_REQUEST` | 400 | A malformed request. |
| `REJECTED` | 422 | `validateHead` refused the file. |
| `TOO_MANY_PARTS` | 422 | The file needs more than 999,999 parts. |
| `UNAUTHORIZED` | 401 | `authorize` refused. |
| `NOT_FOUND` | 404 | Unknown path — check `basePath`. |
| `CONFIG_INVALID` | 500 | A bad `.env` value or option. The message names it. |

---

## License

MIT
