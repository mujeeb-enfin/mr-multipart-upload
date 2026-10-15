// ---------------------------------------------------------------------------
// page-model.ts — one stable locator per element of the demo's upload card
// ---------------------------------------------------------------------------
//
// Enumerated from app/uploader.tsx before any spec was written (CODER.md):
//
//   interactive   file input "Choose a file"; buttons Upload/Resume, Pause,
//                 Discard (destructive, confirms first)
//   live region   status ("Upload status") with the status text and byte count;
//                 progress bar ("Upload progress")
//   conditional   resumed note, error alert, result list, unfinished list,
//                 maximum-size hint
//
// No links, menus, dropdowns, filters, search, tables, modals or toasts exist.
//
// Locator priority per CODER.md: role, then label, then test id. Test ids are
// used only for elements with no accessible role of their own (the byte count,
// result values, the resumed note, the unfinished list).
// ---------------------------------------------------------------------------

import type { Page } from '@playwright/test';

import { type FixtureKey, fixturePath } from './fixtures';

/**
 * A part upload, in every transfer mode:
 *   proxy           PUT /api/uploads/<id>/parts/<n>
 *   direct, S3      PUT <bucket>/<key>?…partNumber=<n>…   (presigned)
 *   direct, Azure   PUT <container>/<blob>?comp=block&blockid=…   (SAS)
 */
export const PART_PUT = /\/api\/uploads\/[^/]+\/parts\/\d+$|[?&]partNumber=\d+(&|$)|[?&]comp=block(&|$)/;
export const COMPLETE_POST = /\/api\/uploads\/[^/]+\/complete$/;

/** The 1-based part number a part-upload URL is for, in every transfer mode. */
export function partIndexOf(url: string): number {
  const parsed = new URL(url);
  const partNumber = parsed.searchParams.get('partNumber');
  if (partNumber) return Number(partNumber);
  const blockId = parsed.searchParams.get('blockid');
  // Azure block ids are base64(4-byte big-endian part index ‖ part SHA-256).
  if (blockId) return Buffer.from(blockId, 'base64').readUInt32BE(0);
  return Number(parsed.pathname.split('/').at(-1));
}

/**
 * Headers for a response the test fakes in place of the storage. A direct
 * part goes to another origin, so without CORS headers the browser would
 * hide the fake status and the client would see a network error instead.
 */
export const FAKE_RESPONSE_CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' };

export function uploaderPage(page: Page) {
  // Scoped to the card: Next.js's route announcer also has role="alert".
  const card = page.getByRole('region', { name: 'Upload a file' });
  return {
    card,
    fileInput: card.getByLabel('Choose a file'),
    uploadButton: card.getByRole('button', { name: /^(Upload|Resume)$/ }),
    pauseButton: card.getByRole('button', { name: 'Pause' }),
    discardButton: card.getByRole('button', { name: 'Discard' }),
    status: card.getByRole('status', { name: 'Upload status' }),
    progress: card.getByRole('progressbar', { name: 'Upload progress' }),
    error: card.getByRole('alert'),
    bytes: card.getByTestId('bytes'),
    sha256: card.getByTestId('sha256'),
    resumed: card.getByTestId('resumed'),
    unfinished: card.getByTestId('unfinished'),
    maxSize: card.getByTestId('max-size'),
    allowedTypes: card.getByTestId('allowed-types'),
    contentType: card.getByTestId('content-type'),
    result: card.getByTestId('result'),

    async open(): Promise<void> {
      await page.goto('/');
      await this.card.waitFor();
    },
    async pick(fixture: FixtureKey): Promise<void> {
      await this.fileInput.setInputFiles(fixturePath(fixture));
    },
    async uploadsOnServer(): Promise<{ fileName: string; receivedBytes: number }[]> {
      const body = await (await page.request.get('/api/uploads')).json();
      return body.uploads;
    },
  };
}

/**
 * Let the first `passThrough` part requests reach the server, then hold every
 * later one until `release()`. The upload is then mid-flight at an exact,
 * known point for as long as the test needs, on any engine at any speed.
 *
 * This replaced a fixed per-part delay: headed Firefox sent all 20 parts
 * before the test could observe "part 2–9", so Pause was already disabled.
 * Pause or discard aborts the held requests; their continue() then finds the
 * request gone ("Route is already handled") — expected, and ignored.
 */
export async function holdPartsAfter(page: Page, passThrough: number): Promise<{ release(): Promise<void> }> {
  let seen = 0;
  let released = false;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => (openGate = resolve));
  await page.route(PART_PUT, async (route) => {
    seen += 1;
    if (seen > passThrough && !released) await gate;
    await route.continue().catch(() => undefined);
  });
  return {
    async release() {
      released = true;
      openGate();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
  };
}

/** Count part requests still open, from the browser's own network events. */
export function trackPartsInFlight(page: Page): () => number {
  let open = 0;
  page.on('request', (req) => {
    if (PART_PUT.test(req.url())) open += 1;
  });
  const settle = (req: { url(): string }) => {
    if (PART_PUT.test(req.url())) open -= 1;
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  return () => open;
}
