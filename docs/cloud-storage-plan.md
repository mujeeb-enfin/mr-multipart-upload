# Plan: cloud storage backends — `local` | `aws_s3` | `azure_blob`

Status: **implemented in 0.3.0** · Non-breaking; `local` stays the default · `minio` added as a fourth kind at the owner's request (2026-10-16)

Implementation notes, where the build differs from or extends this plan:

- Tested without Docker: S3 kinds against **VersityGW** v1.8.0 (an S3 gateway that enforces SigV4 signatures and checksums — moto was rejected after a probe showed it accepts wrong checksums and tampered presigned uploads), Azure against **Azurite** 3.37.0.
- The kept head of part 1 is stored with that part's SHA-256 and trusted only if it equals the provider's record; with direct transfer the content check always runs on the committed bytes.
- Azure with direct transfer reports no composite checksum: Azure verifies MD5 only, and the block ids (which carry the SHA-256) come from the browser.
- Not yet run against real AWS, a MinIO server or Azure; IAM-role, Entra ID and user-delegation paths are untested here.

Decisions taken (2026-10-15):

| Question | Decision |
|---|---|
| Transfer | **Both modes in this release**: `proxy` (browser → Next.js route → cloud) and `direct` (browser → cloud with presigned URLs / SAS) |
| Stored-file checksum | **Provider checksum only** — no read-back of the stored file |
| SDKs | **Optional peer dependencies**, loaded only when that backend is selected |

---

## 1. Research summary (official documentation)

| | local | aws_s3 | azure_blob |
|---|---|---|---|
| Multipart API | our parts + assembly | `CreateMultipartUpload` → `UploadPart` → `CompleteMultipartUpload` | `Put Block` → `Put Block List` |
| Part size | 1–8 MiB | **5 MiB – 5 GiB** (last part smaller) | ≤ **4,000 MiB**, no minimum |
| Parts per file | 999,999 | **10,000** | **50,000** committed / 100,000 uncommitted |
| Resume | list folder | `ListParts` (1,000/page) — needs S3's random **UploadId** | `Get Block List` `blocklisttype=uncommitted` — block IDs are **ours** (Base64, equal length, ≤ 64 bytes) |
| Per-part integrity | our SHA-256 | `x-amz-checksum-sha256`; mismatch → `BadDigest` | `Content-MD5` or `x-ms-content-crc64`; **no SHA-256** |
| Whole-file SHA-256 | exact | **not available** for multipart: SHA-256 is composite-only; full-object checksums are CRC only | **not available** |
| Abandoned uploads | our sweep | billed until aborted → lifecycle `AbortIncompleteMultipartUpload` | uncommitted blocks garbage-collected ~7 days after the last write |
| Read before finishing | yes | no | no |
| Auth | — | IAM user keys, or the SDK default chain (instance profile, ECS task role, EKS/IRSA, SSO, profiles) | connection string, account key, SAS, or Entra ID `DefaultAzureCredential` (managed identity / service principal); role *Storage Blob Data Contributor* |

Vercel Functions cap request bodies at **4.5 MB** (not configurable), so S3's 5 MiB minimum part cannot pass through a Vercel route: `proxy` + `aws_s3` is self-hosted only; Vercel needs `direct`.

Sources: AWS S3 multipart limits (docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html), AWS checking object integrity (…/checking-object-integrity-upload.html), Azure Put Block (learn.microsoft.com/en-us/rest/api/storageservices/put-block), Azure user delegation SAS (learn.microsoft.com/…/storage-blob-create-user-delegation-sas-javascript), AWS SDK v3 credentials (docs.aws.amazon.com/sdk-for-javascript/latest/developer-guide/setting-credentials-node.html), Vercel body limit (vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions).

---

## 2. Configuration

Same precedence as every setting: **parameter → `.env` → default**. The existing `storage` option (a custom adapter object) also accepts the three strings — backward compatible.

| Parameter | `.env` | Default |
|---|---|---|
| `storage` | `MULTIPART_UPLOAD_STORAGE` = `local` \| `aws_s3` \| `azure_blob` | `local` |
| `transfer` | `MULTIPART_UPLOAD_TRANSFER` = `proxy` \| `direct` | `proxy` (`direct` is refused for `local`) |
| `s3.bucket` | `MULTIPART_UPLOAD_S3_BUCKET` | required for `aws_s3` |
| `s3.region` | `MULTIPART_UPLOAD_S3_REGION`, else `AWS_REGION` | required |
| `s3.prefix` | `MULTIPART_UPLOAD_S3_PREFIX` | `''` |
| `s3.endpoint`, `s3.forcePathStyle` | `MULTIPART_UPLOAD_S3_ENDPOINT`, `…_FORCE_PATH_STYLE` | AWS (set for MinIO / R2 / Wasabi) |
| `s3.credentials` | standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | **omitted → IAM role / SDK default chain** |
| `azure.container` | `MULTIPART_UPLOAD_AZURE_CONTAINER` | required for `azure_blob` |
| `azure.accountUrl` | `MULTIPART_UPLOAD_AZURE_ACCOUNT_URL` | required unless a connection string is given |
| `azure.connectionString` / `accountKey` / `sasToken` | `AZURE_STORAGE_CONNECTION_STRING` / `MULTIPART_UPLOAD_AZURE_ACCOUNT_KEY` / `…_SAS_TOKEN` | **none → `DefaultAzureCredential`** |
| `directUrlTtlSeconds` | `MULTIPART_UPLOAD_DIRECT_URL_TTL_SECONDS` | `900` |

Secrets belong in `.env` only. Every value is validated at startup; errors name the setting. `aws_s3` requires `partBytes` 5–8 MiB.

---

## 3. Architecture

A **session-level backend interface** replaces the file-level `StorageAdapter` for the built-in backends (`StorageAdapter` stays for custom backends and wraps into it):

```
interface UploadBackend {
  begin(identity) → { manifest, created }       // manifest stored in the backend, created exclusively
  putPart(manifest, index, bytes, sha256)       // proxy mode
  presignPart(manifest, index, sha256, length)  // direct mode → { url, method, headers, expiresAt }
  listParts(manifest) → [{ index, size, sha256? }]
  readHead(manifest | storedKey, bytes)
  complete(manifest, parts) → { key, size, checksum }
  abort(manifest) / sweep(ttl)
}
```

Unchanged above it: `authorize`, namespaces, the SHA-256 upload id, size limits, `allowedTypes`, error codes, the client API.

### Proxy mode (`transfer: 'proxy'`)
Browser → route → backend. All checks as today: auth on every part, our SHA-256 per part, **content check before the file exists** (the first 64 KB are kept when part 1 arrives).

### Direct mode (`transfer: 'direct'`)
1. `begin` as today (server, authorised).
2. Per part the client calls `POST /api/uploads/:id/parts/:n/url` with the part's SHA-256 (authorised, rate-limited by part count) and receives a short-lived signed request.
3. The browser PUTs the part to S3 / Azure.
4. `complete` (server): list parts, verify every size, commit, **then** content check on the first bytes (ranged read); a refused file is deleted.

Trade-offs, documented: the content check runs after commit (refused files exist briefly); the bucket/container needs **CORS** (S3: allow PUT, expose `ETag`; Azure: allow PUT and `x-ms-*` / `Content-MD5` headers).

---

## 4. Backend details

### aws_s3
- **Manifest** at `<prefix>.parts/<ns>/<uploadId>/manifest.json`, created with `If-None-Match: *` (exclusive). Stores S3's **UploadId** — the one random value, persisted where our derived id points.
- **Final key** chosen at `CreateMultipartUpload`: `<prefix>files/<ns>/<uploadId>.<ext>`.
- Parts with `ChecksumAlgorithm: SHA256`: S3 verifies every part. Direct mode signs `x-amz-checksum-sha256` **and** `Content-Length` into the URL, so S3 enforces both.
- `complete`: paginated `ListParts` → `CompleteMultipartUpload` (ETag + checksum per part, consecutive from 1).
- Discard: `AbortMultipartUpload` + delete manifest. Sweep: `ListMultipartUploads` under the prefix + manifest age; docs give the lifecycle rule.
- IAM permissions documented: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts`, `s3:ListBucketMultipartUploads`.

### azure_blob
- **Blob** `files/<ns>/<uploadId>.<ext>`; manifest blob created with `If-None-Match: *`.
- **Block ID = Base64(4-byte part index + 32-byte part SHA-256)** — fixed 36 bytes, derived, no stored upload id; the part hashes are recoverable from `Get Block List`.
- Proxy: server verifies our SHA-256, then stages with `Content-MD5`. Direct: user-delegation / service SAS (write, one blob, short expiry); the client sends `Content-MD5` (a small built-in MD5, no dependency — Web Crypto has no MD5).
- `complete`: `Get Block List` (uncommitted) → verify sizes → `commitBlockList` (content type set) → content check.
- Discard: delete the blob and manifest. Sweep: manifests older than the TTL (Azure also expires uncommitted blocks).

---

## 5. What changes for users of cloud backends

| | local | aws_s3 / azure_blob |
|---|---|---|
| `checksum` on the stored file | `{ type: 'sha256', value }` — exact | `{ type: 'sha256-composite', value }` — SHA-256 of the concatenated part SHA-256s (S3's definition; computed from block IDs for Azure). **Not** the plain file SHA-256. |
| `sha256` field | exact (unchanged) | **empty string** — documented; use `checksum` |
| Deduplication | yes | no (`deduplicated: false`) — the key is fixed before the content is known |
| Content check | before storing | proxy: before storing · direct: after commit, refused file deleted |
| Max file | 999,999 parts | 10,000 × part size / 50,000 × part size |
| Vercel | no | `direct` only |

New field `checksum` is added for all backends, so code can be written once.

---

## 6. Packaging

Optional `peerDependencies` (+ `peerDependenciesMeta.optional`): `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@azure/storage-blob`, `@azure/identity`. Imported dynamically only when selected; a missing SDK → `CONFIG_INVALID: storage "aws_s3" needs @aws-sdk/client-s3 — npm install @aws-sdk/client-s3`. Local-only installs keep **zero** dependencies. Versions pinned exactly at implementation.

---

## 7. Testing

- **Emulators in Docker**: MinIO (S3, incl. presigned URLs and SHA-256 checksums) and Azurite (Azure, incl. SAS). Containers named `eph-minio-<id>` / `eph-azurite-<id>` with label `io.mr-coder.ephemeral=true`; removed by name only.
- The existing behavioural suites run against **every backend** (one parameterised suite), plus backend-specific tests: UploadId persistence, block-ID derivation, CORS-free proxy path, presigned URL enforcing length and checksum, refused file deleted in direct mode, sweep/abort.
- Opt-in real-cloud smoke tests using a test bucket/container from `.env` (skipped when unset).
- Demo: a backend switch (`local` / `aws_s3` / `azure_blob` × `proxy` / `direct`) via `.env`; e2e against MinIO and Azurite.
- Mutation checks on the critical guards, as for 0.2.0.

---

## 8. Phases

| # | Work | Estimate |
|---|---|---|
| 1 | Backend interface; `local` moved onto it; all existing tests green | 1 day |
| 2 | `aws_s3` proxy + MinIO suite | 1.5 days |
| 3 | `azure_blob` proxy + Azurite suite | 1.5 days |
| 4 | Direct mode: part-URL endpoint, client direct transport, S3 presign, Azure SAS + MD5 | 2 days |
| 5 | Docs (config, IAM policy, CORS, lifecycle rule), demo switch, e2e, release 0.3.0 | 1 day |

Each phase ends green and committed; nothing is published until phase 5.

## 9. Needed from the owner

- Approval of this plan and of the four optional peer dependencies.
- Docker on this machine for MinIO / Azurite.
- Optionally, a test S3 bucket and Azure container (credentials in `.env`, never in chat) for real-cloud smoke tests.
