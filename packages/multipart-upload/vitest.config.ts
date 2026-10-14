import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Most tests write real files. Each test file uses its own temp root, so
    // files can run in parallel; tests inside one file stay sequential.
    fileParallelism: true,
    testTimeout: 30_000,
  },
});
