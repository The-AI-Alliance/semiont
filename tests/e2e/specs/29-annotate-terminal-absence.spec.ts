/**
 * A TERMINAL anchored-text absence still annotates — geometry-only, no hint.
 *
 * ANNOTATE-DEFERS-ON-NOT-YET D2: Annotate defers on `not-yet` **and only on
 * `not-yet`**. For terminal absences (`no-map`, `unknown`, a stored decline)
 * geometry-only annotation IS the feature — nothing better will ever exist for
 * that resource, and deferring would remove spatial annotation from image-like
 * media entirely.
 *
 * `Scanned Smoke PDF` is the terminal case with no race in it: the Smelter
 * stores `declined: no-text-layer` once, permanently, so the answer is settled
 * before this test ever opens the page. That is deliberate — the `not-yet` half
 * of P5 is a timing race against OCR and does not belong in a release gate
 * until a fixture exists that can lose that race reliably.
 *
 * The canvas publishes its own state as `data-annotate-deferred`, so this
 * asserts the FLAG and the consequence, not just the consequence: a test that
 * only drew a rectangle would pass even if the flag were stuck on the wrong
 * value for a resource that happened to still be drawable.
 */

import { test, expect } from '../fixtures/auth';
import type { Page } from '@playwright/test';
import { openResourceByName } from '../fixtures/discover';

const IMG = '.semiont-pdf-annotation-canvas__image';
const SVG = '.semiont-pdf-annotation-canvas__svg';
const CONTAINER = '.semiont-pdf-annotation-canvas__container';
const CANVAS = '.semiont-pdf-annotation-canvas';
const HINT = '.semiont-pdf-annotation-canvas__map-pending';

async function openScannedInAnnotateMode(page: Page) {
  await openResourceByName(page, 'Scanned Smoke PDF');
  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();
  await expect(page.locator(IMG)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(SVG)).toBeVisible({ timeout: 15_000 });
}

/** Highlight + Rectangle. Motivation menuitems TOGGLE, so reset to None first. */
async function armRectangleDrawing(page: Page) {
  await page.getByRole('button', { name: /^motivation$/i }).click();
  await page.getByRole('menuitem', { name: /^none$/i }).click();
  await page.getByRole('button', { name: /^motivation$/i }).click();
  await page.getByRole('menuitem', { name: /^highlight$/i }).click();
  await page.getByRole('button', { name: /^shape$/i }).click();
  await page.getByRole('menuitem', { name: /^rectangle$/i }).click();
  await expect(page.locator(CONTAINER)).toHaveAttribute('data-drawing-mode', 'rectangle', {
    timeout: 5_000,
  });
}

test.describe('annotate on a terminal anchored-text absence', () => {
  test('a stored decline does not defer Annotate, shows no hint, and still draws geometry', async ({
    signedInPage: page,
    bus,
  }) => {
    await openScannedInAnnotateMode(page);

    // D2, the flag itself: a stored decline is terminal, so nothing defers.
    await expect(page.locator(CANVAS)).toHaveAttribute('data-annotate-deferred', 'false', {
      timeout: 15_000,
    });
    await expect(
      page.locator(HINT),
      'the pending-map hint belongs to `not-yet` alone — a terminal absence must not show it',
    ).toHaveCount(0);

    await armRectangleDrawing(page);

    const svgCountBefore = await page.locator(`${SVG} rect`).count();
    bus.clear();

    const box = await page.locator(IMG).boundingBox();
    if (!box) throw new Error('PDF image has no bounding box');
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.60, box.y + box.height * 0.60, { steps: 10 });
    await page.mouse.up();

    // Protocol: the create round-trips, exactly as it does for a readable PDF.
    await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

    // UI: the geometry renders. This is the "geometry-only IS the feature" half.
    await expect
      .poll(async () => page.locator(`${SVG} rect`).count(), { timeout: 30_000 })
      .toBeGreaterThan(svgCountBefore);
  });
});
