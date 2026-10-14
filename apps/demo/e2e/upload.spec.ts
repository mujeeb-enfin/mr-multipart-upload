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

  // unrouteAll, because the `behavior` option exists only there: it drops the
  // delaying handler and ignores errors from the calls it still has in flight.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
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

test('recovers from a 429 and a 503 mid-upload, throttling down, with identical bytes stored', async ({ page }) => {
  // One part is rate-limited (with Retry-After) and another fails with a server
  // error, once each. The upload must retry both through real XHR, show that it
  // was throttled, and still store exactly the source bytes.
  const failed = new Set<string>();
  let throttledShown = false;
  await page.route(PART_PUT, async (route) => {
    const index = route.request().url().split('/').at(-1) as string;
    if (index === '2' && !failed.has('429')) {
      failed.add('429');
      return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Slow down' } }) });
    }
    if (index === '5' && !failed.has('503')) {
      failed.add('503');
      return route.fulfill({ status: 503, body: '' });
    }
    return route.continue().catch(() => undefined);
  });

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(fixturePath('retried'));
  await page.getByTestId('start').click();
  await expect
    .poll(async () => {
      throttledShown ||= ((await page.getByTestId('bytes').textContent().catch(() => '')) ?? '').includes('throttled');
      return page.getByTestId('status').textContent();
    }, { timeout: 60_000, intervals: [50] })
    .toBe('Upload complete');

  expect([...failed].sort()).toEqual(['429', '503']); // both failures were really injected
  expect(throttledShown).toBe(true);
  await expect(page.getByTestId('sha256')).toHaveText(sha256OfFixture('retried'));
});

test('discard during an upload removes everything from the server', async ({ page }) => {
  // Count part requests still open, from the browser's own network events, so
  // the test waits for the real condition instead of a fixed sleep.
  let partsInFlight = 0;
  page.on('request', (req) => PART_PUT.test(req.url()) && (partsInFlight += 1));
  const settle = (req: { url(): string }) => PART_PUT.test(req.url()) && (partsInFlight -= 1);
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);

  await page.route(PART_PUT, async (route) => {
    await new Promise((r) => setTimeout(r, 150));
    await route.continue().catch(() => undefined);
  });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(fixturePath('discarded'));
  await page.getByTestId('start').click();
  await expect(page.getByTestId('bytes')).toContainText(/part [2-9]\//, { timeout: 30_000 });

  await page.getByTestId('discard').click();
  await expect(page.getByTestId('status')).toHaveText('Ready');
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // Parts already in flight may land after the DELETE. Wait until every part
  // request has actually finished or failed, then ask the server directly rather
  // than trusting the UI.
  await expect.poll(() => partsInFlight, { timeout: 15_000 }).toBe(0);
  const listed = await (await page.request.get('/api/uploads')).json();
  expect(listed.uploads.map((u: { fileName: string }) => u.fileName)).not.toContain(FIXTURES.discarded.name);
});

test('a different file with the same name is refused, not merged into the first', async ({ page }) => {
  // Start one report.pdf and pause it; then pick a DIFFERENT report.pdf. The
  // server must refuse with 409 rather than resume onto the first file's parts.
  await page.route(PART_PUT, async (route) => {
    await new Promise((r) => setTimeout(r, 150));
    await route.continue().catch(() => undefined);
  });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(fixturePath('clash'));
  await page.getByTestId('start').click();
  await expect(page.getByTestId('bytes')).toContainText(/part [2-9]\//, { timeout: 30_000 });
  await page.getByTestId('pause').click();
  await expect(page.getByTestId('status')).toHaveText(/Paused/);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  await page.getByTestId('file-input').setInputFiles(fixturePath('clashOther'));
  await page.getByTestId('start').click();
  await expect(page.getByTestId('error')).toContainText('already uses this name');
  await expect(page.getByTestId('status')).toHaveText('Upload failed');

  // The first file is untouched and still resumable to its own exact bytes.
  await page.getByTestId('file-input').setInputFiles(fixturePath('clash'));
  await page.getByTestId('start').click();
  await expect(page.getByTestId('resumed')).toBeVisible();
  await expect(page.getByTestId('status')).toHaveText('Upload complete', { timeout: 60_000 });
  await expect(page.getByTestId('sha256')).toHaveText(sha256OfFixture('clash'));
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
