import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: the PDFJS-6-UNIFY browser acceptance gate.
 *
 * Proves the npm/Vite pdf.js path (post-#885 on `main`) actually renders
 * a PDF in a real browser and that a manually-drawn rectangle annotation
 * round-trips and survives a reload — the one piece no unit test covers.
 *
 * Two implementation facts this spec depends on:
 *
 *  1. The PDF page renders as an `<img>` whose `src` is a data URL pdf.js
 *     produced (`renderPdfPageToDataUrl` → offscreen canvas → toDataURL),
 *     NOT a live `<canvas>` in the DOM (PdfAnnotationCanvas.tsx). So
 *     "renders non-blank" is asserted by drawing that `<img>` into a
 *     canvas and checking pixel variance.
 *
 *  2. Drawing is armed only when BOTH a motivation and a shape are
 *     selected — `AnnotateView` computes `drawingMode = selectedMotivation
 *     ? selectedShape : null`, surfaced on the container as
 *     `data-drawing-mode`. A drag >10px on `.semiont-pdf-annotation-
 *     canvas__container` fires `session.client.mark.request(FragmentSelector,
 *     motivation)`; for `highlighting` the same auto-submit chain as text
 *     runs (`mark:create-request` → `mark:create-ok`). Persisted
 *     annotations re-render as `<rect>` in `.semiont-pdf-annotation-canvas__svg`.
 *
 * Seed dependency: `scripts/seed.ts` yields an `application/pdf` resource
 * named "Spatial Smoke PDF" (seeded oldest so it never displaces the
 * `.first()` card the other specs open).
 */

const PDF_CARD = /^open resource:\s*spatial smoke pdf/i;
const IMG = '.semiont-pdf-annotation-canvas__image';
const SVG = '.semiont-pdf-annotation-canvas__svg';
const CONTAINER = '.semiont-pdf-annotation-canvas__container';

async function openPdfInAnnotateMode(page: import('@playwright/test').Page) {
  await page.goto('/en/know/discover');
  const card = page.getByRole('button', { name: PDF_CARD });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

  // Annotate mode mounts PdfAnnotationCanvas.
  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();

  // The page <img> renders, and the SVG overlay mounts only once display
  // + page dimensions are measured — which is also the precondition for
  // drawing to register (handleMouseUp early-returns without them).
  await expect(page.locator(IMG)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(SVG)).toBeVisible({ timeout: 15_000 });
}

test.describe('pdf render + spatial highlight', () => {
  test('a PDF renders non-blank and a manual rectangle highlight persists across reload', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);

    await openPdfInAnnotateMode(page);

    // ── Renders non-blank ──
    // Draw the rendered page <img> into a canvas and confirm the pixels
    // aren't all identical (a blank/failed render would be uniform white).
    const render = await page.locator(IMG).evaluate((el) => {
      const img = el as HTMLImageElement;
      if (!img.complete || img.naturalWidth === 0) return { ok: false, reason: 'img not loaded', varied: false, src: '' };
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      if (!ctx) return { ok: false, reason: 'no 2d context', varied: false, src: '' };
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let first: string | null = null;
      let varied = false;
      for (let i = 0; i < data.length; i += 4 * 101) {
        const px = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        if (first === null) first = px;
        else if (px !== first) { varied = true; break; }
      }
      return { ok: true, reason: '', varied, src: img.src.slice(0, 16) };
    });
    expect(render.ok, render.reason).toBeTruthy();
    expect(render.src).toContain('data:image');
    expect(render.varied, 'PDF page rendered blank (all sampled pixels identical)').toBeTruthy();

    // ── Arm drawing: Highlight motivation + Rectangle shape ──
    // Motivation menuitems TOGGLE and persist to localStorage, so reset
    // to None first (mirrors 04-manual-highlight). Shape selection is
    // idempotent (rectangle is the only PDF shape).
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^none$/i }).click();
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^highlight$/i }).click();
    await page.getByRole('button', { name: /^shape$/i }).click();
    await page.getByRole('menuitem', { name: /^rectangle$/i }).click();

    // Both selected → drawing is armed. The container reflects this.
    await expect(page.locator(CONTAINER)).toHaveAttribute('data-drawing-mode', 'rectangle', { timeout: 5_000 });

    bus.clear();

    // ── Draw a rectangle: drag from 25%→60% across the rendered page ──
    const box = await page.locator(IMG).boundingBox();
    if (!box) throw new Error('PDF image has no bounding box');
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.60, box.y + box.height * 0.60, { steps: 10 });
    await page.mouse.up();

    // ── Protocol proof: the highlight create round-trips (same chain as
    // text 04 — mark.request → pendingAnnotation auto-submits for
    // 'highlighting' → mark:create-request → mark:create-ok). ──
    await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

    // ── UI proof: the annotation renders as an SVG <rect> in the overlay. ──
    await expect
      .poll(async () => page.locator(`${SVG} rect`).count(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // ── Persistence: reload, re-open in annotate mode, the rect survives. ──
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();
    await expect(page.locator(IMG)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(SVG)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => page.locator(`${SVG} rect`).count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
  });
});
