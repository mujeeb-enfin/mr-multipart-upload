# multipart-upload

Resumable multipart file uploads for **Next.js** — server route handlers, a browser client and a React hook, in TypeScript. Interrupted uploads resume by sending only the parts the server is missing. No database required.

**Documentation:** [`packages/multipart-upload/README.md`](packages/multipart-upload/README.md)

```bash
npm install multipart-upload
```

## Repository layout

```
packages/multipart-upload/   the published package
  src/core/                  part arithmetic, naming, sessions — no I/O
  src/storage/               StorageAdapter and the filesystem backend
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

Pick a large file, pause it, reload the page, and pick it again — only the missing parts are sent. Copy `apps/demo/.env.example` to `apps/demo/.env.local` to change the limits.

## Development

```bash
npm run build           # build the package
npm run typecheck       # all workspaces
npm test                # package unit and integration tests
npm run demo:e2e        # build everything and run the browser tests
npm run check:package   # publint + arethetypeswrong on the packed package
```

The large-file test runs at 40 MB by default; run the full 400 MB scenario with:

```bash
cd packages/multipart-upload
MPU_LARGE_MB=400 npx vitest run test/large-file.test.ts
```

## License

MIT
