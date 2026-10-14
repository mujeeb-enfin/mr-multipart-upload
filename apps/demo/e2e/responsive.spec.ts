// ---------------------------------------------------------------------------
// responsive.spec.ts — the upload journey at the widths the demo ships
// ---------------------------------------------------------------------------
//
// WHAT THIS PROTECTS. A desktop-only suite cannot catch a control pushed off
// screen or a page that scrolls sideways on a phone. At each width: no
// horizontal scroll, every control fully inside the viewport, and the upload
// still completes with identical bytes.
//
// THE VIEWPORT IS SET WHEN THE CONTEXT IS CREATED (test.use), never by resizing
// a live page. An earlier version called page.setViewportSize(), which hangs in
// headed Firefox on Windows — verified on a bare page with none of this app's
// code — and leaves that browser instance unusable, so every Firefox test after
// it failed too. A fresh context per width is also closer to a real device.
// ---------------------------------------------------------------------------

import { sha256OfFixture } from './fixtures';
import { uploaderPage } from './page-model';
import { expect, test } from './test';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`responsive layout at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`upload journey at ${viewport.name} width (${viewport.width}px)`, async ({ page }) => {
      const ui = uploaderPage(page);
      await ui.open();
      await ui.pick('small');

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'page must not scroll horizontally').toBe(0);

      for (const [name, control] of [
        ['file input', ui.fileInput],
        ['Upload', ui.uploadButton],
        ['Pause', ui.pauseButton],
        ['Discard', ui.discardButton],
      ] as const) {
        await expect(control, name).toBeVisible();
        const box = await control.boundingBox();
        expect(box, name).not.toBeNull();
        expect(box!.x, `${name} starts inside the viewport`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${name} ends inside the viewport`).toBeLessThanOrEqual(viewport.width);
      }

      await ui.uploadButton.click();
      await expect(ui.status).toContainText('Upload complete', { timeout: 60_000 });
      await expect(ui.sha256).toHaveText(sha256OfFixture('small'));
    });
  });
}
