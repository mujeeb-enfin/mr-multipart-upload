// ---------------------------------------------------------------------------
// upload.spec.ts — the demo app in a real browser against `next start`
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. The parts unit tests cannot reach: XHR upload progress, a
// real page reload between attempts, the React hook's state, and the
// .env-configured size limit reaching the user. Every test asserts on stored
// bytes (SHA-256), counted requests, or the exact message shown.
// ---------------------------------------------------------------------------

import { expect, test } from '@playwright/test';

import { E2E_MAX_FILE_BYTES, E2E_PART_BYTES } from '../playwright.config';
import { FIXTURES, fixturePath, sha256OfFixture } from './fixtures';

const PART_PUT = /\/api\/uploads\/[^/]+\/parts\/\d+$/;

test('uploads a file and stores byte-identical content', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(fixturePath('small'));
  await page.getByTestId('start').click();

  await expect(page.getByTestId('status')).toHaveText('Upload complete', { timeout: 60_000 });
  await expect(page.getByTestId('sha256')).toHaveText(sha256OfFixture('small'));
  await expect(page.getByTestId('progress')).toHaveAttribute('value', '100');
});

test('resumes after a pause and a page reload, sending only the missing parts', async ({ page }) => {
  const totalParts = Math.ceil(FIXTURES.resumable.size / E2E_PART_BYTES);

  // Slow each part down so there is time to pause mid-upload. Pausing aborts the
  // XHRs this handler is still holding, so its later continue() can find the
  // request already gone ("Route is already handled") — expected, and ignored.
  // Left unhandled, those rejections disrupted the routed run and stalled it.
  await page.route(PART_PUT, async (route) => {
    await new Promise((r) => setTimeout(r, 250));
    await route.continue().catch(() => undefined);
  });

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(fixturePath('resumable'));
  await page.getByTestId('start').click();
  await expect(page.getByTestId('bytes')).toContainText(/part ([3-9]|1\d)\//, { timeout: 30_000 });
  await page.getByTestId('pause').click();
  await expect(page.getByTestId('status')).toHaveText(/Paused/);

  // What the server actually holds now — some in-flight parts may have landed
  // after the pause, so the expectation is derived from the server, not guessed.
  const listed = await (await page.request.get('/api/uploads')).json();
  const received = listed.uploads[0].receivedBytes as number;
  expect(received).toBeGreaterThan(0);
  const missingParts = totalParts - received / E2E_PART_BYTES;

  await page.unroute(PART_PUT, { behavior: 'ignoreErrors' });
  await page.reload();
  await expect(page.getByTestId('unfinished')).toContainText(FIXTURES.resumable.name);

  const sentAfterReload: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && PART_PUT.test(req.url())) sentAfterReload.push(req.url());
  });

  await page.getByTestId('file-input').setInputFiles(fixturePath('resumable'));
  await page.getByTestId('start').click();
  await expect(page.getByTestId('resumed')).toBeVisible();
  await expect(page.getByTestId('status')).toHaveText('Upload complete', { timeout: 60_000 });

  expect(sentAfterReload).toHaveLength(missingParts);
  expect(new Set(sentAfterReload).size).toBe(missingParts); // none sent twice
  await expect(page.getByTestId('sha256')).toHaveText(sha256OfFixture('resumable'));
});

test('refuses a file over MULTIPART_UPLOAD_MAX_FILE_BYTES without sending any part', async ({ page }) => {
  let partRequests = 0;
  page.on('request', (req) => {
    if (PART_PUT.test(req.url())) partRequests += 1;
  });

  await page.goto('/');
  await expect(page.getByTestId('max-size')).toContainText('40 MB');
  await page.getByTestId('file-input').setInputFiles(fixturePath('tooBig'));
  await page.getByTestId('start').click();

  // By test id, not role: Next.js's own route announcer also has role="alert".
  const error = page.getByTestId('error');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('maximum upload size');
  await expect(error).toContainText(String(E2E_MAX_FILE_BYTES));
  await expect(page.getByTestId('status')).toHaveText('Upload failed');
  expect(partRequests).toBe(0);
});
