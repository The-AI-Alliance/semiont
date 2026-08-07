import { test, expect } from '../fixtures/auth';
import type { Page } from '@playwright/test';

import { openResourceByName } from '../fixtures/discover';
/**
 * A scanned PDF whose text cannot be recognized declines cleanly (#739/#746).
 *
 * The scanned path now runs for real: the worker reads the page's pixels and
 * OCRs them rather than refusing outright. This spec pins the *other* outcome —
 * what happens when recognition genuinely comes up empty. Three things must
 * hold, and the third is the one that matters:
 *
 *   1. the job completes rather than failing — a scan we cannot read is not an
 *      error, nothing broke;
 *   2. the user is told why, as an INFO toast (`useOutcomeToasts` →
 *      `declinedMessage`), not a success toast ("Annotation complete" would be
 *      a lie) and not an error toast (alarming, and nothing is wrong);
 *   3. **no annotations are created** — no garbage rects anchored to text the
 *      recognizer never actually read.
 *
 * Seed dependency: `scripts/seed.ts` yields "Scanned Smoke PDF" — a full-page
 * raster with no text operators, whose image is dark bars rather than glyphs so
 * recognition reliably finds nothing.
 *
 * **What this spec cannot prove, and where that is pinned instead.** It asserts
 * the user-visible outcome of a decline. It cannot distinguish "OCR ran and
 * recognized nothing" from "OCR never ran at all" — both produce the identical
 * `no-text-layer` decline and the identical toast. Nothing separating them
 * reaches the browser: `ocrConfidence` and `unreadPages` are deliberately
 * operator-facing (extraction quality is logged, never stored on annotations),
 * and widening the protocol to make a test easier would be the wrong trade.
 *
 * This is not hypothetical. Two bugs on 2026-08-02 made every real scan take
 * the second path — `toRgb` rejecting JPEG-coded images, and `resolveImage`
 * hanging on a shared XObject — and this spec stayed green through both.
 *
 * "The engine actually ran" is pinned where it is observable, in
 * `@semiont/content`: `pdf-ocr.test.ts` asserts `recognizeImages` IS invoked
 * for a page that has an image, alongside the existing case asserting it is NOT
 * invoked for a page that has none. Change either and this spec still passes.
 *
 * NOT covered here, deliberately: a scan OCR *can* read. That needs a genuine
 * scanned document — a synthetic bitmap font is not a typeface, and the
 * recognizer misreads it (measured: "SCANNED" → "SCHMNE" at confidence 0), so
 * asserting recognized text against a seed constant would pin engine noise
 * rather than behavior. That case belongs to live testing with a real receipt
 * or FOIA page; the unit suites in `@semiont/content` cover the merge
 * deterministically with the engine stubbed.
 */

const IMG = '.semiont-pdf-annotation-canvas__image';
const SVG = '.semiont-pdf-annotation-canvas__svg';

async function openScannedPdfInAnnotateMode(page: Page) {
  await openResourceByName(page, 'Scanned Smoke PDF');

  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();
  // A scan still RENDERS — it is a normal PDF page, just one made of pixels.
  await expect(page.locator(IMG)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(SVG)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: /^annotations$/i }).click();
}

async function selectSubTab(page: Page, emoji: string) {
  const tab = page.locator('.semiont-unified-panel__tabs').getByRole('button', { name: emoji, exact: true });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  if ((await tab.getAttribute('aria-pressed')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

test.describe('assisted detection on an unreadable scanned PDF', () => {
  test('completes with a decline notice and creates no annotations', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);

    await openScannedPdfInAnnotateMode(page);
    const rects = page.locator(`${SVG} rect`);
    const rectsBefore = await rects.count();

    await selectSubTab(page, '💬');
    const main = page.getByRole('main');
    const toggle = main.getByRole('button', { name: /annotate comments/i }).first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();

    bus.clear();
    const submit = page.locator('button[data-variant="assist"][data-type="comment"]');
    await expect(submit).toBeEnabled({ timeout: 5_000 });
    await submit.click();

    // Dispatch — the assist crosses the wire like any other detection job. The
    // decline happens in the worker, after it tries to read the page.
    const { request } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);
    expect(request.channel).toBe('job:create');

    // (1) the job COMPLETES rather than failing. Race the two so a genuine
    // failure surfaces with its message instead of a bare timeout (09's
    // pattern). A decline is not an error — `job:fail` here would be a
    // regression to the pre-#746 behavior of throwing on an unreadable page.
    const completeOrFail = await Promise.race([
      bus.waitForRecv('job:complete', { timeout: 90_000 }).then((e) => ({ kind: 'complete' as const, entry: e })),
      bus.waitForRecv('job:fail', { timeout: 90_000 }).then((e) => ({ kind: 'fail' as const, entry: e })),
    ]);
    if (completeOrFail.kind === 'fail') {
      throw new Error(
        'Expected job:complete (a decline), got job:fail. Recent bus entries:\n' +
        bus.entries.slice(-15).map((e) => `  [${e.op}] ${e.channel} ${e.raw}`).join('\n'),
      );
    }

    // (2) the user is told why, as INFO. The bus log records only a payload
    // prefix, so the *reason* is asserted where it actually reaches a
    // human — the toast text `DECLINE_MESSAGES['no-text-layer']` produces.
    await expect(page.getByText(/scan whose text could not be recognized/i))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/annotation complete/i)).toBeHidden();

    // (3) the point: nothing was invented from text the recognizer never read.
    await expect.poll(async () => rects.count(), { timeout: 10_000 }).toBe(rectsBefore);
  });
});
