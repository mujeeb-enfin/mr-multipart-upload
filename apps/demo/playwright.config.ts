import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

// The demo sets maxFileBytes, partBytes and allowedTypes IN CODE
// (app/upload-settings.ts); the suite asserts against those values. The server
// is ALSO given CONFLICTING .env values below, so every test that passes proves
// that a setting in code wins over its .env variable.
const CONFLICTING_ENV = {
  MULTIPART_UPLOAD_MAX_FILE_BYTES: String(40 * 1024 * 1024),
  MULTIPART_UPLOAD_PART_BYTES: String(1024 * 1024),
  MULTIPART_UPLOAD_ALLOWED_TYPES: 'text/plain',
};

/** The server's combined output, read per test by the shared fixture (e2e/test.ts). */
export const SERVER_LOG = join(process.cwd(), 'e2e', '.server-log', 'server.log');

// Headed and headless render differently — headless Chromium is a separate
// binary (chromium-headless-shell) — so a headless baseline never matches a
// headed run; it was measured as a 1px height difference. Each mode keeps its
// own baselines. `--headed` is visible only to the runner process, so it is
// recorded in the environment here, before the runner spawns the workers that
// take the screenshots; they inherit it.
if (process.argv.includes('--headed')) process.env.MPU_E2E_HEADED = '1';
const RENDER_MODE = process.env.MPU_E2E_HEADED === '1' ? 'headed' : 'headless';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // One worker: the server log is read per test by byte offset, which needs
  // tests to run one at a time. Isolation between tests comes from each test's
  // own visitor namespace (see e2e/test.ts), not from ordering.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  // Visual baselines are per browser AND per OS (fonts render differently). A
  // missing baseline is written rather than failed, so the first run on a new
  // platform records one; every later run compares against it.
  updateSnapshots: 'missing',
  snapshotPathTemplate: `{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}-{platform}-${RENDER_MODE}{ext}`,
  expect: {
    // 15 s, not the 5 s default. Most assertions wait on a server round trip
    // plus a React render. On a loaded machine (measured: CPU at 100%), a run
    // failed with the server answering in 16 ms while Playwright's own 5 s
    // expect took 8.8 s to time out — the runner, not the app, was starved.
    // A longer wait only delays reporting a real failure; it cannot pass one.
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  // CODER.md: specs must pass on every engine, not only Chromium.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    // A production build, not `next dev`: dev mode compiles routes on first
    // request, which makes upload timing unrepresentative. serve.ts tees the
    // server's output into SERVER_LOG so tests can assert it logged no errors.
    command: 'node --experimental-strip-types e2e/serve.ts',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      MPU_PORT: String(PORT),
      MPU_SERVER_LOG: SERVER_LOG,
      ...CONFLICTING_ENV,
      MULTIPART_UPLOAD_DIR: './e2e/.fixtures/store',
    },
  },
});
