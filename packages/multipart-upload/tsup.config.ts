import { defineConfig, type Options } from 'tsup';

// Two builds, one per runtime.
//
//   server          platform 'node'    — node:fs, node:crypto, node:stream.
//   client + react  platform 'browser' — built TOGETHER with code splitting.
//
// Why together: built separately, each bundle gets its own copy of the client
// code, so an UploadClientError thrown inside the hook fails an `instanceof`
// check against the UploadClientError exported from `@mr_innovations/multipart-upload/client`.
// Splitting puts the shared code in one chunk that both entries import, so there
// is exactly one class.
//
// The 'use client' banner goes on the browser build only. esbuild strips
// module-level directives while bundling, so it is re-added here. On the server
// build it would mark filesystem code as client code, and Next.js would refuse to
// run it in a route handler.
// No `treeshake` option. It adds a Rollup pass after esbuild, and that pass
// (1) strips the 'use client' banner from every browser file — Rollup reports
// "Module level directives cause errors when bundled… was ignored" — and
// (2) rewrites `node:path` to bare `path`. esbuild already tree-shakes ESM.
const shared: Options = {
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
};

export default defineConfig([
  {
    ...shared,
    entry: { 'server/index': 'src/server/index.ts' },
    platform: 'node',
    target: 'node20',
    // tsup strips `node:` from builtin imports by default, for Node versions
    // older than this package supports. Keep it: `node:fs` cannot be shadowed by
    // an npm package named `fs`, and bundlers recognise it unambiguously.
    removeNodeProtocol: false,
    splitting: false,
  },
  {
    ...shared,
    entry: {
      'client/index': 'src/client/index.ts',
      'react/index': 'src/react/index.ts',
    },
    platform: 'browser',
    splitting: true,
    external: ['react'],
    banner: { js: "'use client';" },
  },
]);
