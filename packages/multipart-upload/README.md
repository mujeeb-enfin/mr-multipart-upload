# @mr_innovations/multipart-upload

Resumable multipart file uploads for **Next.js** — App Router route handlers, a browser client and a React hook, in TypeScript.

Large files are sent in parts. If the connection drops, the tab closes or the server restarts, picking the same file again sends **only the parts the server does not already have**.

- **Four storage backends**: the local filesystem (default), **Amazon S3**, **MinIO** and **Azure Blob Storage** — each using the provider's native multipart API.
- **Two transfer modes**: through your server (`proxy`, default), or straight from the browser to S3 / MinIO / Azure with short-lived signed URLs (`direct`).
- **Configured in code**, with `.env` as the fallback: maximum file size, part size, allowed file types, storage.
- **File types verified by content.** `allowedTypes: ['image/*', 'application/pdf']` refuses a renamed executable, not just a wrong extension.
- **SHA-256 throughout.** Each upload's folder is the SHA-256 of its name, size, MIME type and content fingerprint; every part is checksummed in transit; the stored file is hashed as it is written.
- **No database.** The filesystem is the state; the server works out what it has by listing a directory.
- **Isolated per user.** Two users uploading `photo.jpg` never share anything.
- **Zero runtime dependencies.** Cloud storage SDKs are optional, installed only by apps that use them.

```bash
npm install @mr_innovations/multipart-upload
```

That is all local storage (the default) needs. For cloud storage, also install that provider's SDK — they are **not** installed with this package:

```bash
# aws_s3 or minio
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
# azure_blob
npm install @azure/storage-blob
# azure_blob with Microsoft Entra ID (no connection string or account key)
npm install @azure/storage-blob @azure/identity
```

See [Storage backends](#storage-backends-local-s3-minio-azure) for which package each feature needs.

Requires Node.js 20.9 or later and the Next.js App Router. The package is ESM-only.

## Contents

- [Quick start](#quick-start)
- [A complete example](#a-complete-example)
- [Configuration](#configuration)
- [Storage backends: local, S3, MinIO, Azure](#storage-backends-local-s3-minio-azure)
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
| `storage` | `MULTIPART_UPLOAD_STORAGE` | `local` | `local`, `aws_s3`, `minio` or `azure_blob` — see [Storage backends](#storage-backends-local-s3-minio-azure). |
| `transfer` | `MULTIPART_UPLOAD_TRANSFER` | `proxy` | `proxy` (through your server) or `direct` (browser → cloud storage). |
| `directUrlTtlSeconds` | `MULTIPART_UPLOAD_DIRECT_URL_TTL_SECONDS` | `900` | Lifetime of a direct-transfer URL. |
| `s3`, `minio`, `azure` | `MULTIPART_UPLOAD_S3_*`, `_MINIO_*`, `_AZURE_*` | — | The chosen backend's settings. |

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

## Storage backends: local, S3, MinIO, Azure

| `storage` | Where files go | Install |
|---|---|---|
| `local` (default) | The server's filesystem (`dir`) | nothing |
| `aws_s3` | Amazon S3, or an S3-compatible service (Cloudflare R2, Wasabi, …) | `npm install @aws-sdk/client-s3` (+ `@aws-sdk/s3-request-presigner` for direct transfer) |
| `minio` | A MinIO server | the same two packages as `aws_s3` |
| `azure_blob` | Azure Blob Storage (block blobs) | `npm install @azure/storage-blob` (+ `@azure/identity` for Microsoft Entra ID) |

The SDKs are **optional peer dependencies**. npm, pnpm and Yarn do not install optional peers, so this package never brings them in: an app on local storage has none of them, and an app on cloud storage installs exactly the ones it uses — and an app that already uses the AWS or Azure SDK in a supported version keeps a single copy of it. Each is loaded only when first needed, so a package you do not use is never required.

| Package | Supported versions | Needed for |
|---|---|---|
| `@aws-sdk/client-s3` | `^3.729.0` | `aws_s3`, `minio` |
| `@aws-sdk/s3-request-presigner` | `^3.729.0` | `aws_s3`, `minio` with `transfer: 'direct'` |
| `@azure/storage-blob` | `^12.20.0` | `azure_blob` |
| `@azure/identity` | `^4.0.0` | `azure_blob` with Microsoft Entra ID |

A missing SDK is reported when the backend is first used, as `CONFIG_INVALID` (500) with the command to run:

```
storage "aws_s3" needs the optional package @aws-sdk/client-s3. Install it: npm install @aws-sdk/client-s3
```

Every backend uses the provider's **native multipart upload** — S3 `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload`, Azure `Put Block` / `Put Block List`. Parts are assembled by the provider; nothing is downloaded and re-uploaded. Resume, pause, discard, `allowedTypes`, per-user isolation and the client API work the same on all four.

```ts
createUploadRoutes({
  authorize,
  storage: 'aws_s3',                   // or MULTIPART_UPLOAD_STORAGE
  transfer: 'proxy',                   // or 'direct' — MULTIPART_UPLOAD_TRANSFER
  partBytes: 5 * 1024 * 1024,          // S3 and MinIO require at least 5 MiB
  s3: { bucket: 'my-uploads', region: 'eu-west-1' },
});
```

### Proxy or direct transfer

| | `proxy` (default) | `direct` |
|---|---|---|
| Path of each part | browser → your server → storage | browser → storage, with a short-lived signed URL from your server |
| Your server's bandwidth | carries every byte | carries none of the file |
| Serverless hosts (Vercel, 4.5 MB body limit) | `local` no; cloud only if parts fit the platform's body limit — S3's 5 MiB minimum does not | **yes** |
| Per-part integrity | the server verifies SHA-256; S3 verifies it again | S3: SHA-256 and exact length are **signed into the URL**, S3 enforces them · Azure: MD5 per block, enforced by Azure |
| `allowedTypes` content check | **before** the file exists — a refused file is never stored | **after** commit, on the stored bytes — a refused file is deleted at once |
| Storage configuration needed | none | a **CORS rule** on the bucket / container (below) |
| `local` storage | yes | no |

`direct` is refused for `local` storage, on the first request. URLs live for `directUrlTtlSeconds` (default 900; `MULTIPART_UPLOAD_DIRECT_URL_TTL_SECONDS`), are issued only to the authorised owner of the upload, and never name the stored file — see [How direct URLs are scoped](#cors-for-direct-transfer). The client fetches a fresh URL for every attempt, so an expired one never strands a retry.

### aws_s3

| Parameter | `.env` fallback | Default |
|---|---|---|
| `s3.bucket` | `MULTIPART_UPLOAD_S3_BUCKET` | required |
| `s3.region` | `MULTIPART_UPLOAD_S3_REGION`, then `AWS_REGION` / `AWS_DEFAULT_REGION` | required |
| `s3.prefix` | `MULTIPART_UPLOAD_S3_PREFIX` | none — e.g. `uploads/` |
| `s3.endpoint` | `MULTIPART_UPLOAD_S3_ENDPOINT` | AWS. Set it for R2, Wasabi and other S3-compatible services |
| `s3.forcePathStyle` | `MULTIPART_UPLOAD_S3_FORCE_PATH_STYLE` | `false` |
| `s3.credentials` | — | omitted: the AWS SDK default chain |

**Credentials — two ways.**

1. **An IAM user's access keys.** Pass them, or set the standard variables the AWS SDK reads itself:

   ```ts
   s3: { bucket, region, credentials: { accessKeyId: process.env.S3_KEY!, secretAccessKey: process.env.S3_SECRET! } }
   ```
   ```bash
   AWS_ACCESS_KEY_ID=AKIA…
   AWS_SECRET_ACCESS_KEY=…
   ```

2. **An IAM role — no keys at all.** Leave `credentials` out. The AWS SDK's default chain finds the role: the EC2 instance profile, the ECS task role, EKS IAM Roles for Service Accounts / Pod Identity, Lambda's execution role, AWS SSO, or a named profile. This is the recommended setup on AWS.

**Minimum IAM policy** for the bucket (replace `my-uploads`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": "arn:aws:s3:::my-uploads/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-uploads"
    }
  ]
}
```

**Lifecycle rule — strongly recommended.** S3 bills the parts of an unfinished multipart upload until it is aborted. The library's sweep aborts the ones it tracks; this rule also catches any left by a crash:

```json
{ "Rules": [{ "ID": "abort-incomplete-uploads", "Status": "Enabled", "Filter": {}, "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 3 } }] }
```

### minio

| Parameter | `.env` fallback | Default |
|---|---|---|
| `minio.endpoint` | `MULTIPART_UPLOAD_MINIO_ENDPOINT` | required — e.g. `https://minio.example.com:9000` |
| `minio.bucket` | `MULTIPART_UPLOAD_MINIO_BUCKET` | required |
| `minio.accessKey` | `MULTIPART_UPLOAD_MINIO_ACCESS_KEY` | required |
| `minio.secretKey` | `MULTIPART_UPLOAD_MINIO_SECRET_KEY` | required |
| `minio.region` | `MULTIPART_UPLOAD_MINIO_REGION` | `us-east-1` |
| `minio.prefix` | `MULTIPART_UPLOAD_MINIO_PREFIX` | none |

MinIO has its own users and keys, not AWS IAM, so the keys are required. Path-style addressing is always used. Give the key's MinIO policy the same actions as the IAM policy above.

### azure_blob

| Parameter | `.env` fallback | Default |
|---|---|---|
| `azure.container` | `MULTIPART_UPLOAD_AZURE_CONTAINER` | required |
| `azure.prefix` | `MULTIPART_UPLOAD_AZURE_PREFIX` | none |
| `azure.connectionString` | `MULTIPART_UPLOAD_AZURE_CONNECTION_STRING`, then `AZURE_STORAGE_CONNECTION_STRING` | — |
| `azure.accountUrl` | `MULTIPART_UPLOAD_AZURE_ACCOUNT_URL` | — `https://<account>.blob.core.windows.net` |
| `azure.accountKey` | `MULTIPART_UPLOAD_AZURE_ACCOUNT_KEY` | — |
| `azure.sasToken` | `MULTIPART_UPLOAD_AZURE_SAS_TOKEN` | — |
| `azure.accountName` | `MULTIPART_UPLOAD_AZURE_ACCOUNT_NAME` | read from the URL |

**Credentials — first match wins:**

| You set | Used for | Direct transfer |
|---|---|---|
| a connection string | the account key in it (or the SAS in it) | yes with an account key (service SAS); **no** if it holds only a SAS |
| account URL + account key | shared key | yes (service SAS) |
| account URL + SAS token | the SAS token | **no** — a SAS cannot sign new ones |
| account URL only | **Microsoft Entra ID** via `DefaultAzureCredential`: managed identity, workload identity, a service principal (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`), or a developer login | yes (user delegation SAS) |

With Entra ID, assign the identity **Storage Blob Data Contributor**. For direct transfer it must hold that role (or **Storage Blob Delegator**) at **storage-account scope or above**: the user delegation key that signs the URLs can only be requested there, so a role scoped to the container alone is not enough. Microsoft recommends Entra ID over account keys.

A service SAS (the account-key path) needs **Shared Key access** enabled on the account. With **soft delete or blob versioning** enabled, deleted staging blobs, locks and control files are retained — and billed — for the retention period, and every manifest write creates a version; consider excluding the upload prefix, or a short retention.

### CORS for direct transfer

The browser sends parts from your app's origin straight to the storage, so the storage must allow it.

**S3 / MinIO** — bucket CORS configuration:

```json
[{ "AllowedOrigins": ["https://app.example.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
```

**Azure** — Storage account → Resource sharing (CORS) → Blob service: allowed origin `https://app.example.com`, method `PUT`, allowed headers `*`, exposed headers `*`.

Add the rule alongside any you already have; it does not need to replace them.

**How direct URLs are scoped.** An S3 part URL is signed for one part of one multipart upload, with its SHA-256 and exact length; once the upload is committed it is useless. An Azure SAS cannot be limited to one operation — a write SAS on a blob also allows replacing the whole blob — so Azure part URLs never name the final file. They name a staging blob of that upload session; at `complete` the server copies it to the final key with its own credentials and checks the copy. A URL kept after the upload can at most write to the staging blob, never to the stored file.

### What differs by backend

| | local | aws_s3 / minio | azure_blob |
|---|---|---|---|
| Part size | 1–8 MiB | **5–8 MiB** (S3's minimum is 5 MiB) | 1–8 MiB |
| Most parts per file | 999,999 | 10,000 — 78 GiB at 8 MiB parts | 50,000 |
| `checksum` of the stored file | `sha256`: the exact SHA-256 | `sha256-composite`: SHA-256 of every part's SHA-256 (S3's own definition) | `sha256-composite` with proxy transfer; **null** with direct transfer, where Azure verifies only MD5 |
| `sha256` field | the exact SHA-256 | empty — S3 does not compute a plain SHA-256 of a multipart object | empty |
| Deduplication | yes | no — the object key is fixed before any byte exists | no |
| Default stored key | `files/<user hash>/<sha256>.<ext>` | `<prefix>files/<user hash>/<upload id>-<session id>.<ext>` — fixed when the upload begins, kept through pause, reload and resume; a new upload of the same file gets a new one | the same |
| Commit onto an existing object | — | refused with `DESTINATION_EXISTS`, nothing overwritten, the parts kept | the same |
| Direct transfer | — | parts go to the S3 multipart upload | parts go to a staging blob, copied to the final key at `complete` (one server-side copy) |
| `onComplete` fails | the file is removed, the parts are kept for a retry | the committed object is kept; a retried `complete` re-runs only `onComplete` | the same |
| Server stops mid-`complete` | parts are kept; the retry assembles again | the retry finishes the committed file (`checksum: null`) — after a reload too, which resumes with nothing left to send; discard or the sweep deletes it | the same |
| Unfinished uploads | the sweep | the sweep aborts the S3 session; add the lifecycle rule above | proxy: the sweep deletes a blob holding only uncommitted blocks — never a stored file at the same key; direct: it deletes the session's staging blob, committed or not. Azure also discards uncommitted blocks after about 7 days |

Configuration is read on every request (so a changed `.env` value takes effect without a restart), and a problem is refused on the first request that meets it — before any byte is stored — with the setting named: a part size under 5 MiB for S3, a maximum size needing more parts than the provider allows, `direct` with local storage or with an Azure SAS token (alone or in a connection string). No error ever contains a secret.

**A custom `destination()` on cloud storage must return a different key for every upload** — use `sessionId`, which is new for each upload session and kept while it resumes. The key is chosen before any byte exists, so `sha256` is empty there; a 0.2.x-style `` `uploads/${sha256}.${extension}` `` would give every upload the same key. A commit onto an object the upload did not create is refused with `DESTINATION_EXISTS` rather than overwriting it. That check runs once, before the upload's first commit attempt; a retry of an attempt that failed part-way trusts the key, so a key shared between uploads is still a mistake, not a supported mode.

**Limitations to know.**

- With `direct` transfer to **Azure**, a SAS cannot restrict the size of a block, nor the operation: it also allows replacing the whole staging blob. Neither reaches the stored file — wrong-sized blocks are never committed, the copy is conditional on the exact staging blob that was committed, and the size and content checks read the copy — but a URL stays valid for its lifetime (`directUrlTtlSeconds`), so after an upload ends it can still write a staging blob in that session's folder, billed until Azure's uncommitted-block cleanup (about 7 days) or, if committed, until a sweep or a lifecycle rule on the upload prefix removes it. Keep `directUrlTtlSeconds` short. S3 has no such gap: a part URL is bound to its multipart upload, and useless once that is complete.
- Azure direct `complete` waits for a server-side copy (normally instant within one account). It gives up after 10 minutes and aborts the copy; a retry starts over.
- The composite checksum is not the SHA-256 of the file and cannot be compared with one. It is reproducible from the file and the part size: SHA-256 over the concatenated SHA-256 of each part.
- The cloud backends were tested against S3- and Azure-compatible emulators (VersityGW, which enforces SigV4 signatures and checksums, and Azurite) — not yet against AWS, a MinIO server or Azure themselves. IAM-role, Entra ID and user-delegation paths use the official SDKs' own credential handling and have not been exercised in this project's tests.

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
| `destination(info)` | Choose the storage key of a completed file. `info` holds `sha256`, `extension`, `namespaceKey` and `fileName`; for cloud storage also `uploadId` and `sessionId`. Default: `files/<namespace hash>/<sha256>.<ext>` (local); `files/<namespace hash>/<uploadId>-<sessionId>.<ext>` (cloud, where `sha256` is empty — see [Storage backends](#what-differs-by-backend)). |
| `basePath` | URL the route is mounted at. Default `/api/uploads`. |
| `maxMetadataBytes` | Largest metadata object accepted. Default 16 KB. |
| `headBytes` | Bytes passed to `validateHead`. Default 64 KB. |
| `sweepOnBegin` | Remove expired unfinished uploads when a new one begins. Default `true` for local storage, `false` for cloud storage — there it would cost a request per stored object on every upload start; sweep on a schedule instead. |
| `lockStaleMs` | A finishing lock older than this is treated as abandoned. Default 15 minutes. |
| `onError(error, request)` | Called for unexpected (500) errors. Default: `console.error`. |
| `storage` | A custom storage backend (see [Requirements and limitations](#requirements-and-limitations)). |
| `maxFileBytes`, `partBytes`, `allowedTypes`, `dir`, `partTtlMs`, `instanceId`, `storage`, `transfer`, `directUrlTtlSeconds`, `s3`, `minio`, `azure` | The settings — see [Configuration](#configuration). Each falls back to its `.env` variable, then the default. |

The `file` passed to `onComplete`:

```ts
{
  key: string;                   // storage key, relative to the storage folder (`dir`)
  localPath: string | undefined; // absolute path on disk (always set with the built-in filesystem storage)
  size: number;
  sha256: string;                // lowercase hex, of the stored bytes — local storage; '' for cloud storage
  checksum: { type: 'sha256' | 'sha256-composite'; value: string; parts?: number } | null;
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

There are no background timers. With local storage, expired uploads are removed when a new upload begins (`sweepOnBegin`). With cloud storage that is off by default, so **schedule the sweep** — and on S3 / MinIO add the lifecycle rule from [Storage backends](#aws_s3). To run it on a schedule, create the routes in a shared module so a cron route can reach the same uploader:

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
| `startInfo` | `{ uploadId, resumed, receivedBytes, maxFileBytes, transfer, … }` once the server has answered. |
| `result` | The completed upload: `{ uploadId, fileName, key, size, sha256, checksum, contentType, deduplicated, result }`, where `result` is whatever `onComplete` returned. |
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
- **Direct-transfer URLs are narrow.** Each is issued only to the authorised owner of the upload, for one part, for minutes. On S3 it is a presigned `UploadPart` with the part's SHA-256 and exact length signed in; on Azure a write-only SAS for one blob, with an MD5 Azure verifies. A server configured for `proxy` transfer never issues one.
- **Secrets stay out of errors and logs.** Keys, secrets, SAS tokens and connection strings are never put in an error message; configuration errors name the setting only.
- **The fingerprint is not a secret.** It only tells "the same file again" apart from "a different file". Access control is `authorize`'s job.

---

## Requirements and limitations

- **Local storage needs a persistent, writable filesystem.** Self-hosted `next start`, Docker or a VPS. Serverless platforms with an ephemeral filesystem, such as Vercel functions, cannot keep parts between requests — use `aws_s3`, `minio` or `azure_blob` with `transfer: 'direct'` there.
- **One storage location per deployment.** With local storage on several servers, all must share the storage folder, or requests for one upload must reach the same server. Setting `instanceId` per server turns a cross-server resume into a clear `409 WRONG_INSTANCE` instead of a corrupted file. Cloud storage is shared by nature.
- **ESM only.** Next.js handles this natively.
- **Custom storage backends** implement the `StorageAdapter` interface. It may change before 1.0.

---

## Upgrading from 0.2.x

Nothing changes unless you opt in: `local` storage and `proxy` transfer stay the defaults, with the same behaviour.

- **New:** `storage` (`aws_s3`, `minio`, `azure_blob`), `transfer: 'direct'`, the `checksum` field on the stored file and the client's result, and `transfer` in the client's `onStart` info.
- **Cloud storage needs its SDK installed separately** — see [Storage backends](#storage-backends-local-s3-minio-azure). Apps staying on local storage install nothing new.
- **`storage` also accepts a string.** A custom `StorageAdapter` object still works as before.
- **A pause that lands just after a part was accepted** now ends as `PAUSED`, as it should; it could previously end the upload with a `NETWORK` error.

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
| `DESTINATION_EXISTS` | 409 | Cloud storage: an object this upload did not create already exists at its key — usually a custom `destination()` that is not unique per upload. Nothing overwritten; the parts are kept. |
| `INSECURE_CONTEXT` | — | Client only, direct transfer: the page is not a secure context (HTTPS or `localhost`), so the browser cannot compute the SHA-256 each part is signed with. |

---

## License

MIT © mujeeb-enfin
