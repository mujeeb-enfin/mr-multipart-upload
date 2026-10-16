# @mr_innovations/multipart-upload

Resumable multipart file uploads for **Next.js** — server route handlers, a browser client and a React hook, in TypeScript. Interrupted uploads resume by sending only the parts the server is missing. No database required.

**Documentation:** [`packages/multipart-upload/README.md`](packages/multipart-upload/README.md)

```bash
npm install @mr_innovations/multipart-upload
```

That is enough for local storage. Cloud storage (`aws_s3`, `minio`, `azure_blob`) also needs its provider's SDK, which is not installed with the package — see [Storage backends](packages/multipart-upload/README.md#storage-backends-local-s3-minio-azure).

## Repository layout

```
packages/multipart-upload/   the published package
  src/core/                  part arithmetic, naming, sessions — no I/O
  src/storage/               StorageAdapter, the filesystem backend, and the S3 / MinIO / Azure backends (storage/cloud/)
  src/server/                createUploadRoutes, the uploader, .env config
  src/client/                startUpload, retries, progress
  src/react/                 useMultipartUpload
  test/                      unit and integration tests
apps/demo/                   a complete Next.js app using the package
  e2e/                       Playwright tests in a real browser
```

## Try the demo

```bash
npm install
npm run demo:dev        # builds the package, then starts the demo on http://localhost:3000
```

Pick a large file, pause it, reload the page, and pick it again — only the missing parts are sent. Copy `apps/demo/.env.example` to `apps/demo/.env.local` to change the limits or point the demo at S3, MinIO or Azure.

## Development

```bash
npm run build           # build the package
npm run typecheck       # all workspaces
npm test                # package unit and integration tests
npm run demo:e2e        # build everything and run the browser tests
npm run check:package   # publint + arethetypeswrong on the packed package
```

### Cloud backend tests

`npm test` runs the S3 / MinIO and Azure scenarios only when their emulators are configured, and reports them as skipped otherwise. They run against real protocol implementations, not mocks — locally [VersityGW](https://github.com/versity/versitygw) (an S3 gateway that enforces SigV4 signatures and checksums) and Azurite (a devDependency: `npx azurite-blob --blobPort 10000`):

```bash
MPU_TEST_S3_ENDPOINT=http://127.0.0.1:7070 \
MPU_TEST_S3_ACCESS_KEY=<gateway access key> MPU_TEST_S3_SECRET_KEY=<gateway secret> \
MPU_TEST_AZURE_CONNECTION_STRING="<Azurite connection string>" \
npm test
```

The browser tests run against any storage by setting the same variables an operator would (`MULTIPART_UPLOAD_STORAGE`, `MULTIPART_UPLOAD_TRANSFER` and that backend's settings); `apps/demo/e2e/cloud-setup.ts` creates the bucket or container and its CORS rule.

The large-file test runs at 40 MB by default; run the full 400 MB scenario with:

```bash
cd packages/multipart-upload
MPU_LARGE_MB=400 npx vitest run test/large-file.test.ts
```

## License

MIT
