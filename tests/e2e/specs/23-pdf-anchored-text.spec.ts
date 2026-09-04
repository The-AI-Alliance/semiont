import { test, expect } from '../fixtures/auth';
import type { Page } from '@playwright/test';
import { SemiontClient, resourceId as ridBrand } from '@semiont/sdk';
import { GATEWAY_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

import { openResourceByName } from '../fixtures/discover';
import { signInSession } from '../fixtures/sdk-session';
/**
 * A rectangle drawn on a SCANNED page quotes the text the server recovered.
 *
 * A scanned page has no text in the browser — pdf.js reads glyphs, and there
 * are none, only pixels. The map comes from the server instead: the Smelter
 * OCRs at ingest, publishes through `IContentTransport`, and the canvas fetches
 * it when `getTextContent()` yields no runs. That fetch is the one seam nothing
 * else exercises — the bus channel trio, the correlation reply and the JSON
 * serialisation meet only in `GET /resources/:id/anchored-text`.
 *
 * **Why the map is injected in the second test rather than OCR'd.** The seeded
 * "Scanned Smoke PDF" is a raster of dark bars, chosen precisely so recognition
 * finds nothing (see `scripts/seed.ts`, and `22-pdf-scanned-decline.spec.ts`
 * which pins that outcome). A synthetic bitmap font is not a typeface and
 * tesseract misreads it, so asserting recognized text against a seed constant
 * would pin engine noise. The two tests therefore split the seam:
 *
 *   1. the canvas really asks the server, over the real wire — unmocked;
 *   2. a map that exists really becomes a quote — deterministic, injected.
 *
 * Neither half is interesting alone. Together they cover the path a real
 * scanned document takes, without making the suite depend on how well
 * tesseract reads a fixture nobody intended it to read.
 */

const IMG = '.semiont-pdf-annotation-canvas__image';
const SVG = '.semiont-pdf-annotation-canvas__svg';
const CONTAINER = '.semiont-pdf-annotation-canvas__container';

/**
 * What the Smelter's OCR returns for the Legible Scan fixture. Asserted as two
 * high-confidence WORDS rather than the exact string: the fixture measures at
 * 95.8% mean confidence with 0 low-confidence words, but pinning punctuation
 * and line breaks would pin the engine's formatting rather than the seam.
 */
const QUOTE_WORDS = ['RECOVERED', 'PIXELS'];

const resourceIdFromUrl = (page: Page) => page.url().split('/').pop()!.split('?')[0];

/** Read the STORED annotations the way any client would — a separate signed-in
 *  client, so a pass proves the quote persisted rather than that the browser
 *  still holds it. */
async function storedAnnotations(resourceId: string) {
  const session = await signInSession();
  const client = session.client;
  try {
    return await client.browse.annotations(ridBrand(resourceId)).fresh();
  } finally {
    await session.dispose();
  }
}

/** PDF points -> canvas pixels for a 792pt-tall page rendered 1:1. */
const toCanvas = (y: number, height: number) => 792 - y - height;

async function openLegibleScanInAnnotateMode(page: Page) {
  await openResourceByName(page, 'Legible Scan PDF');

  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();
  await expect(page.locator(IMG)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(SVG)).toBeVisible({ timeout: 15_000 });
}

async function openScannedPdfInAnnotateMode(page: Page) {
  await openResourceByName(page, 'Scanned Smoke PDF');

  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();
  await expect(page.locator(IMG)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(SVG)).toBeVisible({ timeout: 15_000 });
}

/**
 * Arm drawing: Highlight motivation + Rectangle shape. Motivation menuitems
 * TOGGLE and persist to localStorage, so reset to None first (14's note).
 */
async function armRectangleDrawing(page: Page) {
  await page.getByRole('button', { name: /^motivation$/i }).click();
  await page.getByRole('menuitem', { name: /^none$/i }).click();
  await page.getByRole('button', { name: /^motivation$/i }).click();
  await page.getByRole('menuitem', { name: /^highlight$/i }).click();
  await page.getByRole('button', { name: /^shape$/i }).click();
  await page.getByRole('menuitem', { name: /^rectangle$/i }).click();
  await expect(page.locator(CONTAINER)).toHaveAttribute('data-drawing-mode', 'rectangle', { timeout: 5_000 });
}

/** Drag in canvas pixels; jsdom-free here, so use the image's own box. */
async function drawOver(page: Page, top: number, height: number, left = 60, right = 380) {
  const box = await page.locator(IMG).boundingBox();
  if (!box) throw new Error('PDF image has no bounding box');
  const scale = box.height / 792;
  await page.mouse.move(box.x + left * scale, box.y + top * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + right * scale, box.y + (top + height) * scale, { steps: 10 });
  await page.mouse.up();
}

test.describe('scanned PDF annotations quote the server-derived map', () => {
  test('the canvas asks the server for a map when the page has no text layer', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);

    // The ask is a BUS request, not an HTTP GET. `browse.resourceAnchoredText`
    // became `browse:anchored-text-requested` in #1256 ("the gateway's proxy
    // hop is gone"); this test kept waiting for the deleted
    // `GET /resources/:id/anchored-text` and timed out at 60s while the canvas
    // was asking correctly the whole time.
    bus.clear();
    await openScannedPdfInAnnotateMode(page);

    // Request AND reply: the round trip is what proves the channel pair, the
    // Archivist's handler and the correlation reply all work. Which outcome
    // comes back — a map or a decline — is a fact about the seeded scan, not
    // about the seam under test, so it is deliberately not pinned.
    await bus.expectRequestResponse(
      'browse:anchored-text-requested',
      'browse:anchored-text-result',
      60_000,
    );
  });

  test('a rectangle quotes the map the server returned', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);

    // NOTHING IS MOCKED. The Smelter OCR'd this fixture at ingest and the
    // canvas fetches that map over the bus; the rectangle then quotes it.
    //
    // The previous version injected a map with `page.route('**\/anchored-text')`.
    // #1256 moved the read onto the bus, so the interception silently stopped
    // matching — and because the assertion ran over EVERY stored annotation,
    // leftovers from earlier runs kept it green for a week. Depending on the
    // real OCR removes the mock, and scoping to this run's annotations removes
    // the residue.
    await openLegibleScanInAnnotateMode(page);
    const idsBefore = new Set(
      (await storedAnnotations(resourceIdFromUrl(page))).map((a) => String(a.id)),
    );
    await armRectangleDrawing(page);
    bus.clear();

    // The OCR'd words occupy y=543..642 and x=58..450 in PDF points (measured
    // from the map the Smelter returns). Cover both lines, with margin.
    await drawOver(page, toCanvas(642, 0) - 6, 112, 40, 470);

    await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

    const after = await storedAnnotations(resourceIdFromUrl(page));
    const stored = after.filter((a) => !idsBefore.has(String(a.id)));
    expect(stored.length, 'the drawn rectangle persisted a NEW annotation').toBeGreaterThan(0);

    const quotes = stored.flatMap((a) => {
      const sel = (a.target as { selector?: unknown }).selector;
      const all = Array.isArray(sel) ? sel : sel ? [sel] : [];
      return all
        .filter((x): x is { type: string; exact: string } =>
          typeof x === 'object' && x !== null && (x as { type?: string }).type === 'TextQuoteSelector')
        .map((x) => x.exact);
    });

    expect(quotes.length, 'the rectangle produced a TextQuoteSelector').toBeGreaterThan(0);
    const quoted = quotes.join(' ').toUpperCase();
    for (const word of QUOTE_WORDS) {
      expect(
        quoted,
        `the quote carries "${word}" — text that exists ONLY in the server's OCR map, never in the browser`,
      ).toContain(word);
    }

    // And the same text reaches the reader.
    await expect(page.locator('.semiont-unified-panel')).toBeVisible();
    await expect
      .poll(async () => (await page.locator('.semiont-unified-panel').innerText()).toUpperCase().includes('PIXELS'),
        { timeout: 30_000 })
      .toBe(true);
  });
});
