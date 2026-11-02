/**
 * A PDF the Smelter declined cannot be annotated.
 *
 * A viewer lets a person annotate only while it holds the resource's text. The
 * quote of an annotation is cut from that text when the annotation is made,
 * and never again, so a rectangle drawn without the text would have no quote
 * for good. The canvas says where it stands as `data-annotate-deferred`:
 * `false` while it holds the text, `true` while it does not.
 *
 * What the read of each seeded PDF's text answers (`scripts/seed.ts`), and so
 * what its gate must be:
 *
 *   - `Spatial Smoke PDF` and `Cellular Respiration PDF` are typed: the answer
 *     is `extracted`, from the text layer. The gate opens (14 draws on the
 *     first).
 *   - `Legible Scan PDF` is a scan that recognition reads: `extracted`. The
 *     gate opens (23).
 *   - `Hybrid Smoke PDF` has a typed page and an unreadable one: `extracted`,
 *     with the typed page's text. The gate opens (24).
 *   - `Scanned Smoke PDF` is dark bars that recognition reads nothing in: the
 *     Smelter stores `declined: no-text-layer` once, for good. The gate never
 *     opens. That is this spec.
 *
 * 14, 23 and 24 wait for `false` before they drag. This one holds the other
 * side: a decline is an answer, the canvas says the text could not be read,
 * and a drag with a tool chosen draws nothing and asks the server for nothing.
 *
 * `true` alone does not say a decline arrived: the flag is the same while the
 * canvas still waits for an answer. The line that says the text could not be
 * read is shown only for an answer that ends the asking, so that line is what
 * this waits for.
 */

import { test, expect } from '../fixtures/auth';
import type { Page } from '@playwright/test';
import { openResourceByName } from '../fixtures/discover';

const IMG = '.semiont-pdf-annotation-canvas__image';
const SVG = '.semiont-pdf-annotation-canvas__svg';
const CONTAINER = '.semiont-pdf-annotation-canvas__container';
const CANVAS = '.semiont-pdf-annotation-canvas';
const TEXT_UNREADABLE = '.semiont-anchored-text-notice[data-anchored-text="never"]';
const TEXT_AWAITED = '.semiont-anchored-text-notice[data-anchored-text="waiting"]';

async function openScannedInAnnotateMode(page: Page) {
  await openResourceByName(page, 'Scanned Smoke PDF');
  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();
  await expect(page.locator(IMG)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(SVG)).toBeVisible({ timeout: 15_000 });
}

/** Highlight + Rectangle. Motivation menuitems TOGGLE, so reset to None first. */
async function chooseHighlightAndRectangle(page: Page) {
  await page.getByRole('button', { name: /^motivation$/i }).click();
  await page.getByRole('menuitem', { name: /^none$/i }).click();
  await page.getByRole('button', { name: /^motivation$/i }).click();
  await page.getByRole('menuitem', { name: /^highlight$/i }).click();
  await page.getByRole('button', { name: /^shape$/i }).click();
  await page.getByRole('menuitem', { name: /^rectangle$/i }).click();
  // The toolbar holds the choice: what keeps the page from drawing below is
  // the gate, not a tool that was never chosen.
  await expect(page.getByRole('button', { name: /^motivation$/i })).toContainText(/highlight/i);
}

test.describe('annotate on a PDF the Smelter declined', () => {
  test('a stored decline keeps Annotate off: the canvas says the text could not be read, and a drag draws nothing', async ({
    signedInPage: page,
    bus,
  }) => {
    test.setTimeout(120_000);

    await openScannedInAnnotateMode(page);

    // The decline arrived, and the canvas says so.
    await expect(page.locator(TEXT_UNREADABLE)).toBeVisible({ timeout: 60_000 });
    await expect(
      page.locator(TEXT_AWAITED),
      'a decline ends the asking: the canvas is not still waiting for the text',
    ).toHaveCount(0);
    await expect(page.locator(CANVAS)).toHaveAttribute('data-annotate-deferred', 'true');

    const rectsBefore = await page.locator(`${SVG} rect`).count();

    await chooseHighlightAndRectangle(page);
    await expect(
      page.locator(CONTAINER),
      'a tool is chosen, and the page still takes no drawing',
    ).toHaveAttribute('data-drawing-mode', 'none');

    bus.clear();

    const box = await page.locator(IMG).boundingBox();
    if (!box) throw new Error('PDF image has no bounding box');
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.60, box.y + box.height * 0.60, { steps: 10 });

    // Mid-drag, a canvas that was drawing shows the rectangle's dashed outline.
    expect(
      await page.locator(`${SVG} rect`).count(),
      'the drag draws no outline',
    ).toBe(rectsBefore);

    await page.mouse.up();

    // Nothing is made: no rectangle appears, and the server is asked for none.
    await expect
      .poll(async () => page.locator(`${SVG} rect`).count(), { timeout: 10_000 })
      .toBe(rectsBefore);
    expect(bus.emits('mark:create-request'), 'the drag asked for no annotation').toHaveLength(0);

    // And the gate has not moved: a decline is not asked about again.
    await expect(page.locator(CANVAS)).toHaveAttribute('data-annotate-deferred', 'true');
    await expect(page.locator(TEXT_UNREADABLE)).toBeVisible();
  });
});
