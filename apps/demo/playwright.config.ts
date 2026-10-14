import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

// The limits the e2e suite asserts against. Set here, on the server process,
// exactly as an operator would set them in .env.
export const E2E_MAX_FILE_BYTES = 40 * 1024 * 1024;
export const E2E_PART_BYTES = 1024 * 1024;

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
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
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
      MULTIPART_UPLOAD_MAX_FILE_BYTES: String(E2E_MAX_FILE_BYTES),
      MULTIPART_UPLOAD_PART_BYTES: String(E2E_PART_BYTES),
      MULTIPART_UPLOAD_DIR: './e2e/.fixtures/store',
    },
  },
});
