// ---------------------------------------------------------------------------
// accessibility.spec.ts — keyboard-only journey and accessible error state
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. The primary journey must be completable with the keyboard
// alone, in a logical focus order, with a visible focus indicator — the most
// common accessibility regression. Every test here (and in every other spec) is
// also scanned with axe by the shared fixture.
// ---------------------------------------------------------------------------

import { fixturePath, sha256OfFixture } from './fixtures';
import { uploaderPage } from './page-model';
import { expect, test } from './test';

test.describe('accessibility', () => {
  test('completes an upload using only the keyboard', async ({ page }) => {
    const ui = uploaderPage(page);
    await ui.open();

    // Focus order: the file input is the first stop on the page.
    await page.keyboard.press('Tab');
    await expect(ui.fileInput).toBeFocused();

    // Space on a focused file input opens the system file picker.
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Space');
    await (await chooser).setFiles(fixturePath('small'));

    // Next stop: Upload. Pause and Discard are disabled, so they are skipped.
    await page.keyboard.press('Tab');
    await expect(ui.uploadButton).toBeFocused();
    const outline = await ui.uploadButton.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline, 'keyboard focus must be visible').not.toBe('none');

    await page.keyboard.press('Enter');
    await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
    await expect(ui.sha256).toHaveText(sha256OfFixture('small'));
  });

  test('shows the error state accessibly', async ({ page }) => {
    const ui = uploaderPage(page);
    await ui.open();
    await ui.pick('tooBig');
    await ui.uploadButton.click();

    // An alert is announced to assistive technology; the status region names the
    // outcome. The fixture's axe scan then runs against this error state.
    await expect(ui.error).toBeVisible();
    await expect(ui.error).toContainText('maximum upload size');
    await expect(ui.status).toContainText('Upload failed');
  });
});
