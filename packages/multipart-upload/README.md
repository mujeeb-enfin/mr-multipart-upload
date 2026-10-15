# @mr_innovations/multipart-upload

Resumable multipart file uploads for **Next.js** — App Router route handlers, a browser client and a React hook, in TypeScript.

Large files are sent in parts. If the connection drops, the tab closes or the server restarts, picking the same file again sends **only the parts the server does not already have**.

- **Configured in code**, with `.env` as the fallback: maximum file size, part size, allowed file types, storage folder.
- **File types verified by content.** `allowedTypes: ['image/*', 'application/pdf']` refuses a renamed executable, not just a wrong extension.
- **SHA-256 throughout.** Each upload's folder is the SHA-256 of its name, size, MIME type and content fingerprint; every part is checksummed in transit; the stored file is hashed as it is written.
- **No database.** The filesystem is the state; the server works out what it has by listing a directory.
- **Isolated per user.** Two users uploading `photo.jpg` never share anything.
- **Zero runtime dependencies.**

```bash
npm install @mr_innovations/multipart-upload
```

Requires Node.js 20.9 or later and the Next.js App Router. The package is ESM-only.

## Contents

- [Quick start](#quick-start)
- [A complete example](#a-complete-example)
- [Configuration](#configuration)
- [Restricting file types](#restricting-file-types)
- [What users see](#what-users-see)
- [Server API](#server-api--mr_innovationsmultipart-uploadserver)
- [Client API](#client-api)
- [How resume works](#how-resume-works)
- [Security](#security)
- [Requirements and limitations](#requirements-and-limitations)
- [Upgrading from 0.1.x](#upgrading-from-01x)
- [Error codes](#error-codes)

---

## Quick start

### 1. The server: one route file

```ts
// app/api/uploads/[[...path]]/route.ts
import { createUploadRoutes, FILE_TYPES } from '@mr_innovations/multipart-upload/server';
import { auth } from '@/auth'; // your authentication

export const runtime = 'nodejs';        // the filesystem needs the Node.js runtime
export const dynamic = 'force-dynamic'; // uploads must never be cached

export const { GET, POST, PUT, DELETE } = createUploadRoutes({
  // The three main settings. Each is optional; left out, it falls back to its
  // .env variable, then to the default (see Configuration).
  maxFileBytes: 500 * 1024 * 1024,                          // largest file: 500 MB
  partBytes: 2 * 1024 * 1024,                               // each part: 2 MB (1–8 MB)
  allowedTypes: [...FILE_TYPES.images, 'application/pdf'],  // file types accepted

  // Required: who is uploading. Return null to refuse with 401.
  authorize: async () => {
    const session = await auth();
    return session?.user?.id ? { namespace: session.user.id } : null;
  },

  // The file is assembled and stored. Record it; the return value goes to the browser.
  onComplete: async ({ file, namespace }) => ({
    id: file.sha256,
    owner: namespace,
    name: file.fileName,
    size: file.size,
    type: file.contentType, // verified from the file's content
    path: file.localPath,
  }),
});
```

The folder name `[[...path]]` matters: it is an optional catch-all, so this single file handles every upload URL.

### 2. The client: a hook in any client component

```tsx
'use client';
import { useMultipartUpload } from '@mr_innovations/multipart-upload/react';
import { FILE_TYPES } from '@mr_innovations/multipart-upload/client';

const ACCEPT = [...FILE_TYPES.images, 'application/pdf'].join(',');

export function FileUpload() {
  const upload = useMultipartUpload({ endpoint: '/api/uploads' });

  return (
    <div>
      <input type="file" accept={ACCEPT} onChange={(e) => e.target.files?.[0] && upload.start(e.target.files[0])} />
      <progress value={upload.progress?.percent ?? 0} max={100} />
      <button onClick={upload.pause} disabled={upload.status !== 'uploading'}>Pause</button>
      <button onClick={upload.resume} disabled={upload.status !== 'paused'}>Resume</button>
      {upload.startInfo?.resumed && <p>Resuming — only the missing parts will be sent.</p>}
      {upload.error && <p role="alert">{upload.error.message}</p>}
      {upload.result && <p>Stored {upload.result.fileName} ({upload.result.contentType}, {upload.result.size} bytes)</p>}
    </div>
  );
}
```

That is the whole integration. The browser learns the size limit from the server, so it is set in one place only.

---

## A complete example

The [demo app](https://github.com/mujeeb-enfin/mr-multipart-upload/tree/main/apps/demo) in the repository is a working Next.js project. Its settings live in one file and are passed to the route:

```ts
// app/upload-settings.ts
import { FILE_TYPES } from '@mr_innovations/multipart-upload/server';

const MB = 1024 * 1024;

export const MAX_FILE_BYTES = 500 * MB; // 1. largest file accepted
export const PART_BYTES = 2 * MB;       // 2. size of each uploaded part (1–8 MB)
export const ALLOWED_TYPES = [          // 3. file types accepted
  ...FILE_TYPES.webImages,              //    a ready-made list: JPEG, PNG, GIF, WebP
  'video/*',                            //    a wildcard
  'audio/*',
  'application/pdf',                    //    one exact MIME type
  '.zip',                               //    an extension
];
```

```ts
// app/api/uploads/[[...path]]/route.ts
import { createUploadRoutes } from '@mr_innovations/multipart-upload/server';
import { ALLOWED_TYPES, MAX_FILE_BYTES, PART_BYTES } from '../../../upload-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, DELETE } = createUploadRoutes({
  maxFileBytes: MAX_FILE_BYTES,
  partBytes: PART_BYTES,
  allowedTypes: ALLOWED_TYPES,
  authorize,  // your function returning { namespace } or null
  onComplete, // optional
});
```

The same three settings can come from `.env.local` instead — leave them out of the route:

```bash
# .env.local
MULTIPART_UPLOAD_MAX_FILE_BYTES=524288000                                                   # 500 MB
MULTIPART_UPLOAD_PART_BYTES=2097152                                                         # 2 MB
MULTIPART_UPLOAD_ALLOWED_TYPES=image/jpeg,image/png,image/gif,image/webp,video/*,audio/*,application/pdf,.zip
```

---

## Configuration

Pass settings as parameters to `createUploadRoutes()`. Every one is optional, and each is resolved in this order:

1. **The parameter** you pass in code.
2. **The `.env` variable**, when the parameter is left out.
3. **The default**, when neither is set.

| Parameter | `.env` fallback | Default | Meaning |
|---|---|---|---|
| `maxFileBytes` | `MULTIPART_UPLOAD_MAX_FILE_BYTES` | `524288000` (500 MiB) | Largest file accepted, in bytes. |
| `partBytes` | `MULTIPART_UPLOAD_PART_BYTES` | `2097152` (2 MiB) | Bytes per part, between 1 MiB and 8 MiB. |
| `allowedTypes` | `MULTIPART_UPLOAD_ALLOWED_TYPES` (comma-separated) | every type | File types accepted — see [Restricting file types](#restricting-file-types). |
| `dir` | `MULTIPART_UPLOAD_DIR` | `./uploads` | Where parts and finished files are stored. |
| `partTtlMs` | `MULTIPART_UPLOAD_PART_TTL_HOURS` (in **hours**) | 48 hours | Unfinished uploads untouched this long are removed. |
| `instanceId` | `MULTIPART_UPLOAD_INSTANCE_ID` | `single` | A distinct value per server, if you run more than one. |

```ts
createUploadRoutes({
  authorize,
  maxFileBytes: 2 * 1024 * 1024 * 1024,         // 2 GiB
  partBytes: 4 * 1024 * 1024,                   // 4 MiB
  allowedTypes: ['image/*', 'application/pdf'],
  dir: '/var/data/uploads',
  partTtlMs: 24 * 60 * 60 * 1000,               // 24 hours
});
```

### `.env` fallback

Use `.env` when a value should differ per environment without a code change. Add to your app's `.env.local` (or `.env`). These values are the defaults:

```bash
# .env.local
MULTIPART_UPLOAD_MAX_FILE_BYTES=524288000    # 500 MiB — largest file accepted
MULTIPART_UPLOAD_PART_BYTES=2097152          # 2 MiB — between 1048576 and 8388608
MULTIPART_UPLOAD_ALLOWED_TYPES=              # e.g. image/*,application/pdf,.zip — empty: every type
MULTIPART_UPLOAD_DIR=./uploads               # persistent, writable directory
MULTIPART_UPLOAD_PART_TTL_HOURS=48           # unfinished uploads are removed after this
MULTIPART_UPLOAD_INSTANCE_ID=                # set per server if you run more than one
```

Remember to add `uploads/` (or your `dir`) to `.gitignore`.

- `.env` values are read **on every request**, so a changed value takes effect without code changes.
- Invalid values are **refused, never silently corrected** — `maxFileBytes: -1`, `MULTIPART_UPLOAD_MAX_FILE_BYTES=10MB` or `allowedTypes: ['pdf']` fails with an error naming the setting. Use whole numbers of bytes.
- The browser learns the size limit from the server, so it is configured in one place only. An oversized file is refused before any of it is sent.

**Reverse proxies:** each part is one request body. Allow at least the part size plus some headroom — with nginx, `client_max_body_size 10m;` covers the 8 MiB maximum.

---

## Restricting file types

`allowedTypes` takes the same syntax as the HTML `accept` attribute, so one list can drive both the server and the file picker. Each entry is one of:

| Entry | Meaning | Examples |
|---|---|---|
| An exact MIME type | Only that type | `'image/png'`, `'application/pdf'` |
| A wildcard | Every type in the group | `'image/*'`, `'video/*'`, `'audio/*'` |
| An extension | Files with that ending | `'.zip'`, `'.csv'`, `'.docx'` |

```ts
import { createUploadRoutes, FILE_TYPES } from '@mr_innovations/multipart-upload/server';

createUploadRoutes({
  authorize,
  allowedTypes: ['image/*'],                                       // any image
  // allowedTypes: ['image/jpeg', 'image/png', 'application/pdf'], // exact types
  // allowedTypes: ['.zip', '.csv'],                               // by extension
  // allowedTypes: [...FILE_TYPES.images, ...FILE_TYPES.documents], // ready-made lists
});
```

Or in `.env`, comma-separated: `MULTIPART_UPLOAD_ALLOWED_TYPES=image/*,application/pdf,.zip`. Leave both unset to allow every type; pass `allowedTypes: []` to allow every type even when the variable is set.

### What is checked, and when

| When | What | On refusal |
|---|---|---|
| **Upload start** | The type the browser reports (`File.type`) and the extension. | `415 FILE_TYPE_NOT_ALLOWED` before a single byte is sent. |
| **Before the file is stored** | The file's **real content** — its first bytes are matched against known format signatures. | `415 FILE_TYPE_NOT_ALLOWED`. Nothing is stored; the parts are kept (the sweep removes them). |

The first check is for the person uploading: a wrong file is refused instantly. **It is not a security check** — the reported type comes from the file name, which the uploader controls. The second check is: an executable renamed to `photo.png` reports as `image/png`, passes the first check, and is refused by the second.

A file is stored when its content is an allowed type, or is the format it claims to be (a `.docx` is a ZIP archive on disk, so a `.docx` with ZIP content is honest). It is refused when its content is a *different* recognised format, or when it claims a format that always has a signature (PNG, PDF, …) but has none.

The stored file's verified type is `file.contentType` in `onComplete`, and `contentType` in the client's result. Use it rather than the file name.

**Formats verified by content:** JPEG, PNG, GIF, WebP, AVIF, HEIC/HEIF, TIFF, ICO, PDF, ZIP (and ZIP-based: DOCX, XLSX, PPTX, ODT/ODS/ODP, EPUB, JAR, APK), legacy Office (DOC, XLS, PPT), gzip, 7-Zip, RAR, MP3, AAC, M4A, WAV, Ogg, FLAC, MP4, MOV, WebM/MKV, AVI, WebAssembly — and Windows, Linux and macOS executables, so they are recognised under any name.

**Formats with no signature** — plain text, CSV, JSON, Markdown, SVG, HTML — can only be checked by type and extension. Treat their contents as untrusted.

**SVG can contain script.** It is not in `FILE_TYPES.images`. Allow `image/svg+xml` only if you never serve uploaded files inline from your own origin.

**Windows reports `.csv` as `application/vnd.ms-excel`** when Excel is installed. A `.csv` is still accepted under `text/csv` (the extension's usual type counts), and is reported as `text/csv`.

### Ready-made lists — `FILE_TYPES`

Exported from both `/server` and `/client`. Combine them freely: `allowedTypes: [...FILE_TYPES.images, ...FILE_TYPES.pdf]`.

| Preset | Contents |
|---|---|
| `FILE_TYPES.images` | `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/avif`, `image/heic`, `image/heif`, `image/tiff` |
| `FILE_TYPES.webImages` | `image/jpeg`, `image/png`, `image/gif`, `image/webp` |
| `FILE_TYPES.pdf` | `application/pdf` |
| `FILE_TYPES.word` | `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `FILE_TYPES.excel` | `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `FILE_TYPES.powerpoint` | `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `FILE_TYPES.openDocument` | `application/vnd.oasis.opendocument.text`, `…spreadsheet`, `…presentation` |
| `FILE_TYPES.documents` | PDF + Word + Excel + PowerPoint + OpenDocument |
| `FILE_TYPES.spreadsheets` | Excel, `application/vnd.oasis.opendocument.spreadsheet`, `text/csv` |
| `FILE_TYPES.text` | `text/plain`, `text/csv`, `text/markdown`, `application/json` |
| `FILE_TYPES.audio` | `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav`, `audio/ogg`, `audio/flac`, `audio/webm` |
| `FILE_TYPES.video` | `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`, `video/x-msvideo` |
| `FILE_TYPES.archives` | `application/zip`, `application/x-zip-compressed`, `application/gzip`, `application/x-7z-compressed`, `application/vnd.rar` |

### The file picker

`accept` only filters the picker's view — people can still choose "All files" — which is why the server checks both type and content. Use the same list on both sides, or read the server's: `GET /api/uploads` returns `allowedTypes`, ready for `accept`:

```tsx
const [accept, setAccept] = useState('');
useEffect(() => {
  void fetch('/api/uploads').then(async (res) => setAccept(((await res.json()).allowedTypes ?? []).join(',')));
}, []);

<input type="file" accept={accept} onChange={…} />
```

### MIME type reference

For hand-written lists:

| Kind | Extension → MIME type |
|---|---|
| Images | `.jpg` `.jpeg` → `image/jpeg` · `.png` → `image/png` · `.gif` → `image/gif` · `.webp` → `image/webp` · `.avif` → `image/avif` · `.heic` → `image/heic` · `.heif` → `image/heif` · `.tif` `.tiff` → `image/tiff` · `.ico` → `image/x-icon` · `.bmp` → `image/bmp`¹ · `.svg` → `image/svg+xml`¹ ² |
| Documents | `.pdf` → `application/pdf` · `.doc` → `application/msword` · `.docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document` · `.odt` → `application/vnd.oasis.opendocument.text` · `.rtf` → `application/rtf`¹ · `.epub` → `application/epub+zip` |
| Spreadsheets | `.xls` → `application/vnd.ms-excel` · `.xlsx` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` · `.ods` → `application/vnd.oasis.opendocument.spreadsheet` · `.csv` → `text/csv`¹ |
| Presentations | `.ppt` → `application/vnd.ms-powerpoint` · `.pptx` → `application/vnd.openxmlformats-officedocument.presentationml.presentation` · `.odp` → `application/vnd.oasis.opendocument.presentation` |
| Text & data | `.txt` → `text/plain`¹ · `.md` → `text/markdown`¹ · `.json` → `application/json`¹ · `.xml` → `application/xml`¹ · `.html` → `text/html`¹ ² |
| Audio | `.mp3` → `audio/mpeg` · `.m4a` → `audio/mp4` · `.aac` → `audio/aac` · `.wav` → `audio/wav` · `.ogg` `.oga` → `audio/ogg` · `.opus` → `audio/opus` · `.flac` → `audio/flac` · `.weba` → `audio/webm` |
| Video | `.mp4` → `video/mp4` · `.m4v` → `video/x-m4v` · `.mov` → `video/quicktime` · `.webm` → `video/webm` · `.mkv` → `video/x-matroska` · `.avi` → `video/x-msvideo` · `.ogv` → `video/ogg` |
| Archives | `.zip` → `application/zip` (Windows: `application/x-zip-compressed`) · `.gz` → `application/gzip` · `.7z` → `application/x-7z-compressed` · `.rar` → `application/vnd.rar` |

¹ No content signature: checked by type and extension only. ² Can contain script — never serve inline from your origin.

---

## What users see

Refusals arrive as `upload.error.message`, written for the person uploading, with exact figures kept:

| Situation | Message |
|---|---|
| File too large | This file is 600 MB (629,145,600 bytes); the maximum upload size is 500 MB (524,288,000 bytes). |
| Type not allowed | "notes.txt" is not an allowed file type (text/plain). Allowed types: image/*, application/pdf. |
| Renamed file | "photo.png" was refused: its content is a Windows executable, not image/png. Allowed types: image/*. |
| Claimed format, no signature | "photo.png" was refused: it is declared as image/png, but its content is not a valid image/png file. Allowed types: image/*. |

The first two are refused before any of the file is sent. Every error also carries a stable `code` (see [Error codes](#error-codes)) for your own wording.

---

## Server API — `@mr_innovations/multipart-upload/server`

### `createUploadRoutes(options)`

Returns `{ GET, POST, PUT, DELETE, uploader }`. Export the four handlers from your route file.

| Option | Description |
|---|---|
| `authorize(request)` | **Required.** Return `{ namespace }` — usually the user id — or `null` to refuse with 401. Uploads are isolated per namespace. |
| `allowAnonymous` | Accept uploads with no `authorize`. All anonymous callers share one namespace. Use only deliberately. |
| `onComplete(input)` | Called once the file is stored. Receives `{ file, metadata, namespace, uploadId, deduplicated }`. Its return value is sent to the client as `result`. If it throws, a newly stored file is removed and the parts are kept, so the user can retry. |
| `validateHead(bytes, info)` | Inspect the first bytes of the file (64 KB by default) before it is assembled. Throw to refuse with 422. The parts are kept. Runs after the `allowedTypes` content check. |
| `destination(info)` | Choose the storage key of a completed file. Default: `files/<namespace hash>/<sha256>.<ext>`. |
| `basePath` | URL the route is mounted at. Default `/api/uploads`. |
| `maxMetadataBytes` | Largest metadata object accepted. Default 16 KB. |
| `headBytes` | Bytes passed to `validateHead`. Default 64 KB. |
| `sweepOnBegin` | Remove expired unfinished uploads when a new one begins. Default `true`. |
| `lockStaleMs` | A finishing lock older than this is treated as abandoned. Default 15 minutes. |
| `onError(error, request)` | Called for unexpected (500) errors. Default: `console.error`. |
| `storage` | A custom storage backend (see [Requirements and limitations](#requirements-and-limitations)). |
| `maxFileBytes`, `partBytes`, `allowedTypes`, `dir`, `partTtlMs`, `instanceId` | The settings — see [Configuration](#configuration). Each falls back to its `.env` variable, then the default. |

The `file` passed to `onComplete`:

```ts
{
  key: string;                   // storage key, relative to the storage folder (`dir`)
  localPath: string | undefined; // absolute path on disk (always set with the built-in filesystem storage)
  size: number;
  sha256: string;                // lowercase hex, of the stored bytes
  fileName: string;              // the name the user picked
  contentType: string;           // verified from the content where the format has a signature
  read(): ReadableStream<Uint8Array>;
}
```

### `createUploader(options)`

The same functionality without HTTP — `begin`, `putPart`, `status`, `list`, `complete`, `discard`, `sweep` — for custom routes or background jobs.

### Helpers

| Export | |
|---|---|
| `FILE_TYPES` | The ready-made type lists above. |
| `detectFileType(bytes)` | The format of a file's first bytes — `{ mime, label }`, or `null` when unrecognised. Useful inside `validateHead`. |
| `typeForExtension(ext)` | The usual MIME type of an extension (`'pdf'` → `'application/pdf'`). |
| `resolveConfig(options)` | The effective settings after parameters, `.env` and defaults. |

### Cleaning up abandoned uploads

There are no background timers. Expired uploads are removed when a new upload begins (`sweepOnBegin`). To clean up on a schedule as well, create the routes in a shared module so a cron route can reach the same uploader:

```ts
// lib/uploads.ts
import { createUploadRoutes } from '@mr_innovations/multipart-upload/server';
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

### `useMultipartUpload(options)` — `@mr_innovations/multipart-upload/react`

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
| `result` | The completed upload: `{ uploadId, fileName, key, size, sha256, contentType, deduplicated, result }`, where `result` is whatever `onComplete` returned. |
| `error` | An `UploadClientError` with `message`, `status`, `code` and `details`. |

Unmounting the component pauses the upload; it never discards it.

### `startUpload(options)` — `@mr_innovations/multipart-upload/client`

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

`/client` also exports `FILE_TYPES`, for building the picker's `accept` list in the browser.

**Retries.** Network errors, 5xx, 408 and 429 are retried with exponential backoff, honouring `Retry-After`. On a 429 the upload drops to one part at a time for the rest of the run. Other 4xx errors are not retried — they would fail the same way again.

**Progress** never goes backwards, and reaches 100% only after the server has assembled the file.

---

## How resume works

1. The browser sends the file's name, size, MIME type and a **fingerprint** derived from its size, modification time, name, and a hash of its first and last 64 KB.
2. The server computes the **upload id: the SHA-256 of the file name, size, MIME type and fingerprint.** It is also the name of the upload's temporary folder.
3. If that folder exists in the user's namespace, it is the same file: the server lists the folder and answers with the part numbers it is missing.
4. The browser sends only the missing parts.

On disk:

```
uploads/
  .parts/<namespace hash>/<upload id: sha256(name, size, MIME type, fingerprint)>/
    manifest.json                      name, size, MIME type, fingerprint, part size
    000001.3f9a1c07b2d4e816.part … 000200.3f9a1c07b2d4e816.part
  files/<namespace hash>/<sha256 of the stored bytes>.mp4
```

Because the folder is a hash of all four, a file that differs in **any** of them — another file with the same name, the same file re-saved, the same name with a different type — gets its own folder and can never share or merge parts with another. The file name does not appear in any folder name. Two different files with the same name are simply two uploads.

Each part's name also carries a **tag derived from the fingerprint**, and a part only counts as received if it has this upload's tag *and* exactly the right size, so a part cut off mid-write is re-sent automatically, and a stray part from anywhere else is ignored and removed when the upload completes. Parts are created with an exclusive-create flag, so two simultaneous attempts at the same part can never interleave.

**Three SHA-256 values guard every upload:**

1. The **upload id** binds the name, size, MIME type and fingerprint.
2. Each **part** is verified against the SHA-256 the browser computed before sending it. A part altered on the way — by a proxy, a network fault or a browser bug — is refused with a retryable `PART_CHECKSUM_MISMATCH` instead of being stored; if it keeps happening the upload fails loudly, never "succeeding" with a corrupted file. This matters in practice: during testing, a WebKit build sent the wrong bytes for sliced `Blob`s at the correct length, which passed every size check. (The client therefore sends each part as an `ArrayBuffer`, correct in every engine tested.) Part checksums need the browser's built-in hashing, available only in secure contexts — HTTPS or `localhost`; on plain HTTP the upload still works, without this guarantee.
3. The **stored file** is hashed as it is assembled; its size must equal the declared size or nothing is stored. It is returned as `sha256`, with `size` and the verified `contentType`.

**The one remaining blind spot:** two *different* files with the same name, size, type and modification time whose first and last 64 KB are also identical — differing only in the middle — get the same fingerprint and therefore the same upload id, and the second would resume onto the first's parts. If your users may produce such files, include something that distinguishes them in the file name.

---

## Security

- **`authorize` is required.** Omitting it throws when the route module loads, so a misconfiguration fails `next build`, not production.
- **Per-user isolation.** Namespaces are hashed into directory names, so user ids of any form are safe, and one user can never read, resume, complete or discard another's upload.
- **File types are verified by content.** With `allowedTypes` set, a file is checked by its declared type when it starts and by its actual first bytes before it is stored, so a renamed executable is refused. See [Restricting file types](#restricting-file-types).
- **Size limits are enforced in the route.** A part is refused by its `Content-Length` before it is read, and reading stops at the limit if that header is wrong or missing.
- **Paths are contained.** Upload ids are SHA-256 hashes — 64 lowercase hex characters — so no file name ever becomes part of a path, and every storage key passes a containment check against the storage directory.
- **Deduplication is per user.** Identical files from the same user are stored once. It is deliberately not shared across users: a shared store would tell one user, through `deduplicated: true`, that someone else had uploaded the same file. A custom `destination` can change this — knowingly.
- **The fingerprint is not a secret.** It only tells "the same file again" apart from "a different file". Access control is `authorize`'s job.

---

## Requirements and limitations

- **A persistent, writable filesystem.** Self-hosted `next start`, Docker or a VPS. Serverless platforms with an ephemeral filesystem, such as Vercel functions, cannot keep parts between requests, so the built-in storage does not work there.
- **One storage location per deployment.** With several servers, all must share the storage folder, or requests for one upload must reach the same server. Setting `instanceId` per server turns a cross-server resume into a clear `409 WRONG_INSTANCE` instead of a corrupted file.
- **ESM only.** Next.js handles this natively.
- **Custom storage backends** implement the `StorageAdapter` interface. It is marked experimental until a second backend exists and may change before 1.0.

---

## Upgrading from 0.1.x

- **Upload ids changed.** They are now the SHA-256 of the name, size, MIME type and fingerprint, instead of the file name. Unfinished uploads started on 0.1.x cannot be resumed after upgrading — the same file starts a new upload — and the sweep removes the old folders after `partTtlMs`. Finished files are unaffected.
- **Two different files with the same name are now two separate uploads.** `NAME_IN_USE` no longer means "this name is taken"; see [Error codes](#error-codes).
- **New:** `allowedTypes`, `FILE_TYPES`, `contentType` on the stored file and the client's result, `FILE_TYPE_NOT_ALLOWED`. Nothing is restricted unless you set `allowedTypes`.

---

## Error codes

Every error response is `{ "error": { "code", "message", "details"? } }`.

| Code | Status | Meaning |
|---|---|---|
| `FILE_TOO_LARGE` | 413 | Over `maxFileBytes`. `details.maxFileBytes` holds the limit. |
| `FILE_TYPE_NOT_ALLOWED` | 415 | Not in `allowedTypes` — by declared type at start, or by content before storing. `details` holds `allowedTypes`, `declaredType` and, for a content refusal, `detectedType`. |
| `BODY_TOO_LARGE` | 413 | A request body over its limit. |
| `METADATA_TOO_LARGE` | 413 | Metadata over `maxMetadataBytes`. |
| `NAME_IN_USE` | 409 | The stored upload under this id no longer describes the file (an edited manifest), or another request is starting it right now. |
| `FINGERPRINT_MISMATCH` | 409 | A part for a different file than the upload in progress. |
| `PART_IN_FLIGHT` | 409 | Another request is writing that part right now. Retried automatically. |
| `COMPLETE_IN_PROGRESS` | 409 | The upload is already being finished. |
| `INCOMPLETE` | 409 | Parts are missing. `details.missingParts` lists them. |
| `WRONG_INSTANCE` | 409 | The upload's parts are on another server. |
| `NO_SESSION` | 404 | No such upload for this user. |
| `PART_LENGTH_MISMATCH` | 400 | A part of the wrong size. |
| `PART_CHECKSUM_MISMATCH` | 422 | A part's bytes changed in transit. Nothing stored; retried automatically. |
| `PART_OUT_OF_RANGE` | 400 | A part number outside the upload. |
| `INVALID_NAME` | 400 | The file name contains a control character. |
| `INVALID_REQUEST` | 400 | A malformed request. |
| `CLIENT_DISCONNECTED` | 400 | The browser went away mid-request — normal on pause or discard. Not reported to `onError`. |
| `REJECTED` | 422 | `validateHead` refused the file. |
| `TOO_MANY_PARTS` | 422 | The file needs more than 999,999 parts. |
| `UNAUTHORIZED` | 401 | `authorize` refused. |
| `NOT_FOUND` | 404 | Unknown path — check `basePath`. |
| `CONFIG_INVALID` | 500 | A bad `.env` value or option. The message names it. |

---

## License

MIT © mujeeb-enfin
