/**
 * Captures uncaught browser-side errors during a Playwright test.
 *
 * Surfaces what `page.on('pageerror', ...)` and `page.on('console', ...)`
 * hand the test process — uncaught exceptions, unhandled promise
 * rejections (relayed through the browser's `unhandledrejection`),
 * and red-text `console.error` lines.
 *
 * Why a separate fixture? Bug-hunting in the wild (the live-monitoring
 * workflow at `tests/e2e/docs/live-monitoring.md`) has surfaced
 * frontend bugs that the e2e suite didn't catch — including a
 * `RangeError: Maximum call stack size exceeded` in an RxJS Subject's
 * `.next()` triggered by a failed token refresh. The suite was blind
 * to those because no fixture observed page-level errors.
 *
 * Usage from a spec is automatic — every test that depends on
 * `signedInPage` gets `pageErrors` transitively (see `auth.ts`'s
 * fixture chain). Tests can assert at any point::
 *
 *     test('something', async ({ signedInPage: page, pageErrors }) => {
 *       await page.goto('/some/route');
 *       // ... interact ...
 *       expect(pageErrors.entries).toEqual([]);
 *     });
 *
 * The default behavior on test teardown is **soft**: the fixture
 * attaches a `page-errors.json` artifact when there are entries, and
 * fails the test only if `PAGE_ERRORS_FAIL=1` is set. This lets new
 * specs surface latent errors as evidence (visible in the report)
 * without immediately failing the suite. Once the suite is clean,
 * flip `PAGE_ERRORS_FAIL=1` in CI to lock the baseline.
 */

import type { ConsoleMessage, Page, TestInfo } from '@playwright/test';

const FAIL_ON_ERRORS = process.env.PAGE_ERRORS_FAIL === '1';

export type PageErrorKind = 'pageerror' | 'console.error';

export interface PageErrorEntry {
  kind: PageErrorKind;
  message: string;
  stack?: string;
  at: number;
}

export class PageErrorsCapture {
  readonly entries: PageErrorEntry[] = [];

  ingestException(err: Error): void {
    this.entries.push({
      kind: 'pageerror',
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      at: Date.now(),
    });
  }

  ingestConsole(msg: ConsoleMessage): void {
    if (msg.type() !== 'error') return;
    this.entries.push({
      kind: 'console.error',
      message: msg.text(),
      at: Date.now(),
    });
  }

  /** Reset between phases of a test. */
  clear(): void {
    this.entries.length = 0;
  }
}

export async function attachPageErrors(page: Page): Promise<PageErrorsCapture> {
  const capture = new PageErrorsCapture();
  page.on('pageerror', (err) => capture.ingestException(err));
  page.on('console', (msg) => capture.ingestConsole(msg));
  return capture;
}

/**
 * Teardown hook — attaches a `page-errors.json` artifact when entries
 * were captured, and (optionally) fails the test on entries.
 */
export async function attachPageErrorsArtifact(
  testInfo: TestInfo,
  capture: PageErrorsCapture,
): Promise<void> {
  if (capture.entries.length === 0) return;

  const body = JSON.stringify({
    test: testInfo.title,
    count: capture.entries.length,
    failOnErrors: FAIL_ON_ERRORS,
    entries: capture.entries,
  }, null, 2);

  await testInfo.attach('page-errors.json', {
    body,
    contentType: 'application/json',
  });

  if (FAIL_ON_ERRORS) {
    const summary = capture.entries.slice(0, 3).map((e) => `  [${e.kind}] ${e.message}`).join('\n');
    throw new Error(
      `Page surfaced ${capture.entries.length} uncaught error(s) during the test:\n${summary}\n\n` +
      `(see attached page-errors.json for the full list and stacks)`,
    );
  }
}
