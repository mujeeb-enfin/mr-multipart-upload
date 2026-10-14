// ---------------------------------------------------------------------------
// test.ts — the shared fixture every spec imports instead of @playwright/test
// ---------------------------------------------------------------------------
//
// Applies CODER.md's e2e rules to every test automatically, so no spec can
// forget them:
//
//   isolation      each test gets its own visitor cookie, so its own server
//                  namespace: no test sees another's uploads, in any order
//   console        console errors and uncaught page errors fail the test
//   network        responses >= 400 and failed requests fail the test
//   server log     errors the server logged during the test fail it
//   accessibility  an axe scan (WCAG 2.1 A/AA) of the final page state
//   report         { test, consoleErrors, networkErrors, serverErrors,
//                  a11yViolations } written per test and attached to it
//
// Errors a negative-path test provokes on purpose are declared, with a reason,
// in error-allowlist.ts. Anything else fails.
// ---------------------------------------------------------------------------

import { readFileSync, statSync, writeFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { test as base, expect } from '@playwright/test';

import { SERVER_LOG } from '../playwright.config';
import { ALLOWED_ERRORS, type AllowedErrors } from './error-allowlist';

export { expect };

const VISITOR_COOKIE = 'demo_visitor';
/** Lines the server writes for real errors: Next.js's ⨯ marker, the library's tag, stack traces. */
const SERVER_ERROR_LINE = /⨯|\[mr-multipart-upload\]|\bError\b|\bFATAL\b|ECONN|Unhandled/;

function logSize(): number {
  try {
    return statSync(SERVER_LOG).size;
  } catch {
    return 0;
  }
}

function serverLinesSince(offset: number): string[] {
  try {
    return readFileSync(SERVER_LOG).subarray(offset).toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function isAllowedConsole(text: string, allowed: AllowedErrors | undefined): boolean {
  if (!allowed) return false;
  const status = /status of (\d{3})/.exec(text)?.[1];
  if (status && allowed.statuses?.includes(Number(status))) return true;
  return allowed.console?.some((pattern) => pattern.test(text)) ?? false;
}

export const test = base.extend({
  page: async ({ page, context, baseURL }, use, testInfo) => {
    const allowed = ALLOWED_ERRORS[testInfo.title];

    // Isolation: a visitor id unique to this test (and browser project).
    const visitor = `e2e-${testInfo.testId}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64);
    await context.addCookies([{ name: VISITOR_COOKIE, value: visitor, url: baseURL as string }]);

    const consoleErrors: string[] = [];
    const networkErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isAllowedConsole(msg.text(), allowed)) consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${err.message}`));
    page.on('response', (res) => {
      if (res.status() >= 400 && !allowed?.statuses?.includes(res.status())) {
        networkErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      }
    });
    page.on('requestfailed', (req) => {
      if (!allowed?.abortedRequests?.test(req.url())) {
        networkErrors.push(`failed ${req.method()} ${req.url()}: ${req.failure()?.errorText}`);
      }
    });

    const logOffset = logSize();
    await use(page);

    const serverErrors = serverLinesSince(logOffset).filter((line) => SERVER_ERROR_LINE.test(line));

    let a11yViolations: string[] = [];
    if (!page.isClosed() && page.url().startsWith(baseURL as string)) {
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      a11yViolations = scan.violations.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`);
    }

    const report = { test: testInfo.titlePath.join(' > '), project: testInfo.project.name, consoleErrors, networkErrors, serverErrors, a11yViolations };
    const reportPath = testInfo.outputPath('error-report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('error-report', { path: reportPath, contentType: 'application/json' });

    expect(consoleErrors, 'browser console errors').toEqual([]);
    expect(networkErrors, 'unexpected network errors').toEqual([]);
    expect(serverErrors, 'errors in the server log during this test').toEqual([]);
    expect(a11yViolations, 'accessibility violations (axe, WCAG 2.1 A/AA)').toEqual([]);
  },
});
