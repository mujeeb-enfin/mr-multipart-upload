import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

// The limits the e2e suite asserts against. Set here, on the server process,
// exactly as an operator would set them in .env.
export const E2E_MAX_FILE_BYTES = 40 * 1024 * 1024;
export const E2E_PART_BYTES = 1024 * 1024;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // A production build, not `next dev`: dev mode compiles routes on first
    // request, which makes upload timing in these tests unrepresentative.
    command: `npx next start --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      MULTIPART_UPLOAD_MAX_FILE_BYTES: String(E2E_MAX_FILE_BYTES),
      MULTIPART_UPLOAD_PART_BYTES: String(E2E_PART_BYTES),
      MULTIPART_UPLOAD_DIR: './e2e/.fixtures/store',
    },
  },
});
