import { test, expect } from '../fixtures/auth';
import type { Page } from '@playwright/test';

import { openResourceByName } from '../fixtures/discover';
/**
 * A hybrid PDF — one typed page, one scanned — works through the live stack.
 *
 * Class C is the only extraction class where native text and OCR'd text share a
 * document, so it is the only one where the offset arithmetic has to be right:
 * OCR output is *appended* after the native text, and every native item must
 * keep pointing at the characters it pointed at before. Get the shift wrong and
 * every annotation on the typed page silently moves.
 *
 * **What is already pinned elsewhere.** `@semiont/content`'s `pdf-ocr.test.ts`
 * covers the assembly thoroughly against a *mocked* recognizer — native and
 * OCR'd items coexisting, each still selecting its own text, `unreadPages`
 * reported in both directions. Mocking the engine is what lets those tests
 * assert recovered text at all, and that is the right place for it. What no unit
 * test reaches is the same document travelling the real path: smelted at ingest,
 * served to a browser, rendered, annotated. Every seeded PDF before this one was
 * class A (typed) or a class B scan that declines; none carried a hybrid.
 *
 * **Why nothing here asserts recognized text.** The fixture's second page is a
 * raster of dark bars, not rendered glyphs. A synthetic bitmap is not a typeface
 * and the recognizer misreads it (measured: 'SCANNED' -> 'SCHMNE' at confidence
 * 0), so a seed constant compared against OCR output would pin engine noise.
 * Page 2 lands on the gap-reporting branch instead — not a consolation prize:
 * it is the branch a real scan with one unreadable page takes, and asserting the
 * document still works *around* that gap is the point.
 *
 * **Selectors are structural, deliberately.** Annotate mode renders the
 * virtualized continuous-scroll layout (`annotate-renderers.tsx` passes
 * `pageLayout="scroll"`), where every page is a `__slot[data-page]` and only
 * on-screen slots mount a raster. Page-number *text* is i18n'd through
 * `t('pageOf')`, so matching it would pin a translation string; `data-page`
 * is the stable contract. It also keeps `__image` scoped to one page — with a
 * multi-page document a bare `.__image` locator matches several and trips
 * Playwright's strict mode, which is why the single-page specs get away with it
 * and this one must not.
 */

const CONTAINER = '.semiont-pdf-annotation-canvas__container';
const slot = (page: number) => `.semiont-pdf-annotation-canvas__slot[data-page="${page}"]`;
const stripPage = (page: number) => `button.semiont-pdf-annotation-canvas__strip-page[data-page="${page}"]`;

/** Drawn on page 1 by the fixture generator; see `scripts/seed.ts`. */
const NATIVE_PHRASE = 'genuine text layer';

async function openHybridInAnnotateMode(page: Page) {
  await openResourceByName(page, 'Hybrid Smoke PDF');

  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();
  await expect(page.locator(CONTAINER)).toBeVisible({ timeout: 30_000 });
}

/** Highlight + Rectangle. Motivation menuitems TOGGLE and persist, so reset to
 *  None first (14's note). */
async function armRectangleDrawing(page: Page) {
  await page.getByRole('button', { name: /^motivation$/i }).click();
  await page.getByRole('menuitem', { name: /^none$/i }).click();
  await page.getByRole('button', { name: /^motivation$/i }).click();
  await page.getByRole('menuitem', { name: /^highlight$/i }).click();
  await page.getByRole('button', { name: /^shape$/i }).click();
  await page.getByRole('menuitem', { name: /^rectangle$/i }).click();
  await expect(page.locator(CONTAINER)).toHaveAttribute('data-drawing-mode', 'rectangle', { timeout: 5_000 });
}

test.describe('a hybrid PDF (typed page + scanned page)', () => {
  test('both pages survive ingest, and the typed page is annotatable', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);

    await openHybridInAnnotateMode(page);

    // A hybrid must not be truncated to the half the extractor could read.
    // Slots exist for every page whether or not a raster is mounted, so this
    // asks about the document rather than about virtualization.
    await expect(page.locator(slot(1))).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(slot(2))).toHaveCount(1);
    await expect(page.locator('.semiont-pdf-annotation-canvas__slot')).toHaveCount(2);

    const img = page.locator(`${slot(1)} .semiont-pdf-annotation-canvas__image`);
    await expect(img).toBeVisible({ timeout: 30_000 });

    await armRectangleDrawing(page);
    bus.clear();

    // Page 1's text runs from y=720 down to y=640 in PDF points — the upper
    // band. PDF space is bottom-left origin, so that is canvas y≈72..152 on a
    // 792pt page; drawn generously across it.
    const box = await img.boundingBox();
    if (!box) throw new Error('page 1 has no bounding box');
    const scale = box.height / 792;
    await page.mouse.move(box.x + 60 * scale, box.y + 60 * scale);
    await page.mouse.down();
    await page.mouse.move(box.x + 540 * scale, box.y + 170 * scale, { steps: 10 });
    await page.mouse.up();

    await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

    // The payoff, and the class-C-specific part: the quote comes from the NATIVE
    // text layer of a document that also holds OCR'd content. If appending had
    // shifted native offsets, this quote would be wrong or empty even though the
    // rectangle landed in the right place.
    await expect(page.locator('.semiont-unified-panel')).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        async () => (await page.locator('.semiont-unified-panel').innerText()).toLowerCase(),
        { timeout: 30_000 },
      )
      .toContain(NATIVE_PHRASE);
  });

  test('the scanned page is reachable and carries no invented annotations', async ({ signedInPage: page }) => {
    test.setTimeout(120_000);

    await openHybridInAnnotateMode(page);

    // Page 2 is the unreadable half. A gap in extraction is not a gap in the
    // document — a reader still has to be able to look at it. The strip tick is
    // the layout's own way there, and clicking it scrolls page 2 into view,
    // which is what mounts its raster under virtualization.
    await page.locator(stripPage(2)).click();

    const img2 = page.locator(`${slot(2)} .semiont-pdf-annotation-canvas__image`);
    await expect(img2).toBeVisible({ timeout: 30_000 });

    // And nothing was fabricated from it. The recognizer read this page and
    // found nothing legible, so the document's text is page 1's alone — the
    // "reported, not invented" contract `unreadPages` exists to keep. Asserted
    // as an absence that has had its chance to appear: the raster above is
    // already on screen, so an overlay would have rendered by now.
    await expect(page.locator(`${slot(2)} .semiont-pdf-annotation-canvas__svg rect`)).toHaveCount(0);
  });
});
