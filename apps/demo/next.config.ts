import { resolve } from 'node:path';

import type { NextConfig } from 'next';

// The package lives two directories up in the workspace. Turbopack only reads
// files under its root, so the root is set to the repository, not this app.
const workspaceRoot = resolve(process.cwd(), '..', '..');

const config: NextConfig = {
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
};

export default config;
