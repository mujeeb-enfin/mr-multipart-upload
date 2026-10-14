// ---------------------------------------------------------------------------
// visual.spec.ts — snapshots of the upload card in its stable states
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. Unintended layout and style changes fail automatically
// instead of waiting for someone to notice. Only STABLE states are snapshotted:
// idle, completed and refused. Mid-upload is not — the byte count and progress
// change continuously, and a snapshot that differs every run gets deleted.
//
// Nothing here is volatile: fixtures are deterministic, so the SHA-256 and the
// stored key are identical every run, and each test's isolated namespace means
// no other test's uploads appear in the card. Baselines are per browser and per
// OS (see playwright.config.ts).
// ---------------------------------------------------------------------------

import { uploaderPage } from './page-model';
import { expect, test } from './test';

test.describe('visual', () => {
  test('idle state', async ({ page }) => {
    const ui = uploaderPage(page);
    await ui.open();
    await expect(ui.maxSize).toBeVisible();
    await expect(ui.card).toHaveScreenshot('idle.png');
  });

  test('completed state', async ({ page }) => {
    const ui = uploaderPage(page);
    await ui.open();
    await ui.pick('small');
    await ui.uploadButton.click();
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
    await expect(ui.card).toHaveScreenshot('completed.png');
  });

  test('error state', async ({ page }) => {
    const ui = uploaderPage(page);
    await ui.open();
    await ui.pick('tooBig');
    await ui.uploadButton.click();
    await expect(ui.error).toBeVisible();
    await expect(ui.card).toHaveScreenshot('error.png');
  });
});
