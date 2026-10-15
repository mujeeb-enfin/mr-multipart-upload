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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEMO_ALLOWED_TYPES, DEMO_MAX_FILE_BYTES, DEMO_PART_BYTES } from '../app/upload-settings';

// The demo's values, set in code. The server also runs with CONFLICTING .env
// values (playwright.config.ts), so these passing proves code wins over .env.
const E2E_MAX_FILE_BYTES = DEMO_MAX_FILE_BYTES;
const E2E_PART_BYTES = DEMO_PART_BYTES;
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
  test('a different file with the same name is a separate upload, never merged into the first', async ({ page }) => {
    // Each upload's folder is the SHA-256 of its name, size, type and content
    // fingerprint, so a second "report.pdf" gets its own folder.
    const ui = uploaderPage(page);
    const parts = await holdPartsAfter(page, 2);
    await ui.open();
    await ui.pick('clash');
    await ui.uploadButton.click();
    await expect(ui.bytes).toContainText('part 2/');
    await ui.pauseButton.click();
    await expect(ui.status).toContainText('Paused');
    await parts.release();

    // The other file starts fresh — none of the first file's parts are reused —
    // and stores exactly its own bytes.
    await ui.pick('clashOther');
    await ui.uploadButton.click();
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
    await expect(ui.resumed).toHaveCount(0);
    await expect(ui.sha256).toHaveText(sha256OfFixture('clashOther'));

    // The first file is untouched: still 2 parts on the server, and it resumes
    // to its own exact bytes.
    const first = (await ui.uploadsOnServer()).find((u) => u.fileName === FIXTURES.clash.name);
    expect(first?.receivedBytes).toBe(2 * E2E_PART_BYTES);
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
    // 500 MB from the code, not the 40 MB the server's .env says.
    await expect(ui.maxSize).toHaveText('Maximum upload size: 500 MB (set by maxFileBytes in the upload route)');
    await ui.pick('tooBig');
    await ui.uploadButton.click();

    // The exact message the person reads: readable sizes, exact bytes kept.
    expect(FIXTURES.tooBig.size).toBe(525_336_576);
    expect(E2E_MAX_FILE_BYTES).toBe(524_288_000);
    await expect(ui.error).toHaveText(
      'This file is 501 MB (525,336,576 bytes); the maximum upload size is 500 MB (524,288,000 bytes).',
    );
    await expect(ui.status).toContainText('Upload failed');
    expect(partRequests).toBe(0);
  });
});

test.describe('allowed file types', () => {
  // The demo's list, set in code in app/upload-settings.ts.
  const allowedList = DEMO_ALLOWED_TYPES.join(', ');

  test('.env.example lists the same allowed types as the code', () => {
    // Protects the documentation: a reader copying .env.example must get the
    // list the demo actually runs with, not a stale one.
    const line = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('MULTIPART_UPLOAD_ALLOWED_TYPES='));
    expect(line?.slice('MULTIPART_UPLOAD_ALLOWED_TYPES='.length).trim().split(',')).toEqual([...DEMO_ALLOWED_TYPES]);
  });

  test("the picker and the hint show the server's allowed types", async ({ page }) => {
    const ui = uploaderPage(page);
    await ui.open();
    expect(DEMO_ALLOWED_TYPES).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/*', 'audio/*', 'application/pdf', '.zip']);
    await expect(ui.allowedTypes).toHaveText(`Allowed types: ${allowedList} (set by allowedTypes in the upload route)`);
    await expect(ui.fileInput).toHaveAttribute('accept', DEMO_ALLOWED_TYPES.join(','));
  });

  test('stores a real image and shows the type verified from its content', async ({ page }) => {
    const ui = uploaderPage(page);
    await ui.open();
    await ui.pick('photo');
    await ui.uploadButton.click();
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
    await expect(ui.contentType).toHaveText('image/png');
    await expect(ui.sha256).toHaveText(sha256OfFixture('photo'));
  });

  test('refuses an executable renamed to .png by its content, storing nothing', async ({ page }) => {
    // The browser reports "holiday.png" as image/png, so the first check passes
    // and every part is sent; the content check before storing refuses it.
    const ui = uploaderPage(page);
    await ui.open();
    await ui.pick('disguisedExe');
    await ui.uploadButton.click();
    await expect(ui.error).toHaveText(
      `"holiday.png" was refused: its content is a Windows executable, not image/png. Allowed types: ${allowedList}.`,
      { timeout: 60_000 },
    );
    await expect(ui.status).toContainText('Upload failed');
    await expect(ui.result).toHaveCount(0);
    // Nothing stored; the parts are kept for the sweep, as documented.
    const held = (await ui.uploadsOnServer()).find((u) => u.fileName === FIXTURES.disguisedExe.name);
    expect(held?.receivedBytes).toBe(FIXTURES.disguisedExe.size);
  });

  test('refuses a disallowed type before sending any part', async ({ page }) => {
    const ui = uploaderPage(page);
    let partRequests = 0;
    page.on('request', (req) => PART_PUT.test(req.url()) && (partRequests += 1));
    await ui.open();
    await ui.pick('notes');
    await ui.uploadButton.click();
    await expect(ui.error).toHaveText(`"notes.txt" is not an allowed file type (text/plain). Allowed types: ${allowedList}.`);
    await expect(ui.status).toContainText('Upload failed');
    expect(partRequests).toBe(0);
  });
});
