// ---------------------------------------------------------------------------
// upload.spec.ts — the upload journey in a real browser against `next start`
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. What unit tests cannot reach: XHR upload progress, real
// page reloads, the React hook's state, the .env size limit reaching the user,
// and the buttons' real effects. Assertions are on stored bytes (SHA-256),
// counted requests, server state, and the exact text shown — never on liveness.
//
// Coverage (elements enumerated in page-model.ts):
//   file input     enabled/disabled per state; picking enables Upload
//   Upload/Resume  disabled without a file and while busy; label in pause; effect
//   Pause          enabled only while uploading; effect; inert when disabled
//   Discard        disabled when nothing to discard; confirms; accept AND cancel
//   status/progress/error/result/resumed/unfinished — asserted in context
//
// Every test runs on chromium, firefox and webkit, isolated in its own visitor
// namespace, with console, network, server-log and axe checks from test.ts.
// UNKNOWNs: none.
// ---------------------------------------------------------------------------

import { E2E_MAX_FILE_BYTES, E2E_PART_BYTES } from '../playwright.config';
import { FIXTURES, sha256OfFixture } from './fixtures';
import { COMPLETE_POST, PART_PUT, holdPartsAfter, trackPartsInFlight, uploaderPage } from './page-model';
import { expect, test } from './test';

test.describe('uploading', () => {
  test('uploads a file and stores byte-identical content', async ({ page }) => {
    const ui = uploaderPage(page);
    await ui.open();

    // Idle: nothing to upload, pause or discard.
    await expect(ui.fileInput).toBeEnabled();
    await expect(ui.uploadButton).toBeDisabled();
    await expect(ui.pauseButton).toBeDisabled();
    await expect(ui.discardButton).toBeDisabled();
    await expect(ui.status).toContainText('Ready');

    // A disabled button does nothing, even when clicked programmatically.
    let requests = 0;
    page.on('request', (req) => req.url().includes('/api/uploads') && req.method() !== 'GET' && (requests += 1));
    await ui.pauseButton.dispatchEvent('click');
    await ui.uploadButton.dispatchEvent('click');
    expect(requests).toBe(0);

    await ui.pick('small');
    await expect(ui.uploadButton).toBeEnabled();
    await ui.uploadButton.click();

    // Busy-state controls are asserted in "locks the controls…", which slows the
    // upload down enough to observe them; this small file can finish first.
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
    await expect(ui.sha256).toHaveText(sha256OfFixture('small'));
    await expect(ui.progress).toHaveAttribute('value', '100');
    await expect(ui.pauseButton).toBeDisabled();
    await expect(ui.discardButton).toBeDisabled();
  });

  test('locks the controls while an upload is in progress', async ({ page }) => {
    const ui = uploaderPage(page);
    const parts = await holdPartsAfter(page, 0);
    await ui.open();
    await ui.pick('retried');
    await ui.uploadButton.click();

    await expect(ui.status).toContainText('Uploading');
    await expect(ui.fileInput).toBeDisabled();
    await expect(ui.uploadButton).toBeDisabled();
    await expect(ui.pauseButton).toBeEnabled();
    await expect(ui.discardButton).toBeEnabled();

    await parts.release();
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
    await expect(ui.fileInput).toBeEnabled();
  });

  test('resumes after a pause and a page reload, sending only the missing parts', async ({ page }) => {
    const ui = uploaderPage(page);
    const totalParts = Math.ceil(FIXTURES.resumable.size / E2E_PART_BYTES);
    const parts = await holdPartsAfter(page, 3);
    await ui.open();
    await ui.pick('resumable');
    await ui.uploadButton.click();
    await expect(ui.bytes).toContainText(`part 3/${totalParts}`);
    await ui.pauseButton.click();
    await expect(ui.status).toContainText('Paused');
    await expect(ui.uploadButton).toHaveText('Resume');

    // Exactly the three parts let through reached the server: the held ones
    // were aborted by the pause before they were sent.
    const held = (await ui.uploadsOnServer()).find((u) => u.fileName === FIXTURES.resumable.name);
    expect(held?.receivedBytes).toBe(3 * E2E_PART_BYTES);
    const missingParts = totalParts - 3;

    await parts.release();
    await page.reload();
    await expect(ui.unfinished).toContainText(FIXTURES.resumable.name);

    const sentAfterReload: string[] = [];
    page.on('request', (req) => req.method() === 'PUT' && PART_PUT.test(req.url()) && sentAfterReload.push(req.url()));
    await ui.pick('resumable');
    await ui.uploadButton.click();
    await expect(ui.resumed).toBeVisible();
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });

    expect(sentAfterReload).toHaveLength(missingParts);
    expect(new Set(sentAfterReload).size).toBe(missingParts);
    await expect(ui.sha256).toHaveText(sha256OfFixture('resumable'));
  });

  test('recovers from a 429 and a 503 mid-upload, throttling down, with identical bytes stored', async ({ page }) => {
    const ui = uploaderPage(page);
    const injected = new Set<string>();
    await page.route(PART_PUT, async (route) => {
      const index = route.request().url().split('/').at(-1);
      if (index === '2' && !injected.has('429')) {
        injected.add('429');
        return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, contentType: 'application/json', body: '{"error":{"code":"RATE_LIMITED","message":"Slow down"}}' });
      }
      if (index === '5' && !injected.has('503')) {
        injected.add('503');
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      }
      return route.continue().catch(() => undefined);
    });

    await ui.open();
    await ui.pick('retried');
    await ui.uploadButton.click();
    await expect(ui.bytes).toContainText('throttled by the server', { timeout: 30_000 });
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });

    expect([...injected].sort()).toEqual(['429', '503']);
    await expect(ui.sha256).toHaveText(sha256OfFixture('retried'));
  });

  test('a failed finish is reported, keeps every part, and succeeds on retry', async ({ page }) => {
    const ui = uploaderPage(page);
    let failedOnce = false;
    await page.route(COMPLETE_POST, async (route) => {
      if (!failedOnce) {
        failedOnce = true;
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"INTERNAL","message":"The upload could not be processed."}}' });
      }
      return route.continue().catch(() => undefined);
    });

    await ui.open();
    await ui.pick('small');
    await ui.uploadButton.click();
    await expect(ui.error).toHaveText('The upload could not be processed.', { timeout: 60_000 });
    await expect(ui.status).toContainText('Upload failed');

    // Retry: every part is already on the server, so not one is sent again.
    let partsSent = 0;
    page.on('request', (req) => PART_PUT.test(req.url()) && (partsSent += 1));
    await ui.uploadButton.click();
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
    expect(partsSent).toBe(0);
    await expect(ui.sha256).toHaveText(sha256OfFixture('small'));
  });
});

test.describe('discarding', () => {
  test('asks for confirmation, and discarding removes everything from the server', async ({ page }) => {
    const ui = uploaderPage(page);
    const partsInFlight = trackPartsInFlight(page);
    const parts = await holdPartsAfter(page, 2);
    await ui.open();
    await ui.pick('discarded');
    await ui.uploadButton.click();
    await expect(ui.bytes).toContainText('part 2/');

    const dialogs: string[] = [];
    page.once('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    await ui.discardButton.click();
    await expect(ui.status).toContainText('Ready');
    expect(dialogs).toEqual(['Discard this upload? The parts already sent will be deleted from the server.']);
    await parts.release();

    // Released parts were aborted by the discard; wait for every request to
    // settle, then ask the server rather than trusting the UI. (A part landing
    // DURING the delete is covered by the removeTree storage test.)
    await expect.poll(partsInFlight, { timeout: 15_000 }).toBe(0);
    expect((await ui.uploadsOnServer()).map((u) => u.fileName)).not.toContain(FIXTURES.discarded.name);
  });

  test('cancelling the discard confirmation keeps the upload', async ({ page }) => {
    const ui = uploaderPage(page);
    const parts = await holdPartsAfter(page, 2);
    await ui.open();
    await ui.pick('discarded');
    await ui.uploadButton.click();
    await expect(ui.bytes).toContainText('part 2/');
    await ui.pauseButton.click();
    await expect(ui.status).toContainText('Paused');
    await parts.release();

    page.once('dialog', (dialog) => void dialog.dismiss());
    await ui.discardButton.click();

    await expect(ui.status).toContainText('Paused');
    await expect(ui.uploadButton).toHaveText('Resume');
    const held = (await ui.uploadsOnServer()).find((u) => u.fileName === FIXTURES.discarded.name);
    expect(held?.receivedBytes).toBe(2 * E2E_PART_BYTES);
  });
});

test.describe('refusals', () => {
  test('a different file with the same name is refused, not merged into the first', async ({ page }) => {
    const ui = uploaderPage(page);
    const parts = await holdPartsAfter(page, 2);
    await ui.open();
    await ui.pick('clash');
    await ui.uploadButton.click();
    await expect(ui.bytes).toContainText('part 2/');
    await ui.pauseButton.click();
    await expect(ui.status).toContainText('Paused');
    await parts.release();

    await ui.pick('clashOther');
    await ui.uploadButton.click();
    await expect(ui.error).toContainText('already uses this name');
    await expect(ui.status).toContainText('Upload failed');

    // The first file is untouched and still resumes to its own exact bytes.
    await ui.pick('clash');
    await ui.uploadButton.click();
    await expect(ui.resumed).toBeVisible();
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
    await expect(ui.sha256).toHaveText(sha256OfFixture('clash'));
  });

  test('refuses a file over MULTIPART_UPLOAD_MAX_FILE_BYTES without sending any part', async ({ page }) => {
    const ui = uploaderPage(page);
    let partRequests = 0;
    page.on('request', (req) => PART_PUT.test(req.url()) && (partRequests += 1));

    await ui.open();
    await expect(ui.maxSize).toContainText('40 MB');
    await ui.pick('tooBig');
    await ui.uploadButton.click();

    // The exact message the person reads: readable sizes, exact bytes kept.
    expect(FIXTURES.tooBig.size).toBe(42_991_616);
    expect(E2E_MAX_FILE_BYTES).toBe(41_943_040);
    await expect(ui.error).toHaveText(
      'This file is 41 MB (42,991,616 bytes); the maximum upload size is 40 MB (41,943,040 bytes).',
    );
    await expect(ui.status).toContainText('Upload failed');
    expect(partRequests).toBe(0);
  });
});
