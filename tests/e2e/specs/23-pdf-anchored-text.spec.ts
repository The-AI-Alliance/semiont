import { test, expect } from '../fixtures/auth';
import type { Page } from '@playwright/test';
import { BACKEND_URL } from '../playwright.config';

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

const SCANNED_CARD = /^open resource:\s*scanned smoke pdf/i;
const IMG = '.semiont-pdf-annotation-canvas__image';
const SVG = '.semiont-pdf-annotation-canvas__svg';
const CONTAINER = '.semiont-pdf-annotation-canvas__container';
const ANCHORED_TEXT = '**/anchored-text';

/** The seeded scan is 612x792pt; a map placed here sits on the upper-left. */
const QUOTE = 'recovered from the pixels';
const MAP = {
  text: QUOTE,
  items: QUOTE.split(' ').reduce<{ items: unknown[]; x: number; at: number }>((acc, word) => {
    acc.items.push({
      start: acc.at, end: acc.at + word.length,
      page: 1, x: acc.x, y: 700, width: word.length * 7, height: 12,
    });
    return { items: acc.items, x: acc.x + word.length * 7 + 5, at: acc.at + word.length + 1 };
  }, { items: [], x: 72, at: 0 }).items,
};

const resourceIdFromUrl = (page: Page) => page.url().split('/').pop()!.split('?')[0];

/** The signed-in session's bearer, wherever the app parked it. */
async function bearerToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      const match = (localStorage.getItem(key) ?? '').match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (match) return match[0];
    }
    return '';
  });
}

/** PDF points -> canvas pixels for a 792pt-tall page rendered 1:1. */
const toCanvas = (y: number, height: number) => 792 - y - height;

async function openScannedPdfInAnnotateMode(page: Page) {
  await page.goto('/en/know/discover');
  const card = page.getByRole('button', { name: SCANNED_CARD }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

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
async function drawOver(page: Page, top: number, height: number) {
  const box = await page.locator(IMG).boundingBox();
  if (!box) throw new Error('PDF image has no bounding box');
  const scale = box.height / 792;
  await page.mouse.move(box.x + 60 * scale, box.y + top * scale);
  await page.mouse.down();
  await page.mouse.move(box.x + 380 * scale, box.y + (top + height) * scale, { steps: 10 });
  await page.mouse.up();
}

test.describe('scanned PDF annotations quote the server-derived map', () => {
  test('the canvas asks the server for a map when the page has no text layer', async ({ signedInPage: page }) => {
    test.setTimeout(120_000);

    // Armed before opening, so the request cannot be missed: the canvas fetches
    // at page load, not at drag.
    const asked = page.waitForRequest(
      (r) => r.url().includes('/anchored-text') && r.method() === 'GET',
      { timeout: 60_000 },
    );

    await openScannedPdfInAnnotateMode(page);

    const request = await asked;
    expect(request.url()).toMatch(/\/resources\/[^/]+\/anchored-text$/);

    // And the answer is served, not 404 — the route, the bus trio and the
    // correlation reply all have to work for this to arrive at all.
    const response = await request.response();
    expect(response?.status()).toBe(200);
  });

  test('a rectangle quotes the map the server returned', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);

    // The seeded scan recognizes as nothing by design, so serve a known map for
    // this resource. Everything downstream — the SDK accessor, `textUnder`, the
    // selector pair, the panel — is the real code path.
    await page.route(ANCHORED_TEXT, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MAP) }));

    await openScannedPdfInAnnotateMode(page);
    await armRectangleDrawing(page);
    bus.clear();

    // The map's words sit at y=700..712 in PDF points.
    await drawOver(page, toCanvas(700, 12) - 4, 20);

    await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

    // The contract, asserted where it is unambiguous: the STORED annotation
    // carries a quote built from a map the browser could not have read. A
    // panel renders `getExactText` off this; the selector is the thing that
    // has to be right.
    const stored = await page.request.get(`${BACKEND_URL}/resources/${resourceIdFromUrl(page)}/jsonld`, {
      headers: { Authorization: `Bearer ${await bearerToken(page)}` },
    });
    expect(stored.status()).toBe(200);
    expect(await stored.text()).toContain(`"TextQuoteSelector","exact":"${QUOTE}"`);

    // And the same text reaches the reader. The annotations panel is already
    // open in annotate mode — clicking the toolbar button would CLOSE it.
    await expect(page.locator('.semiont-unified-panel')).toBeVisible();
    await expect
      .poll(async () => (await page.locator('.semiont-unified-panel').innerText()).includes(QUOTE), { timeout: 30_000 })
      .toBe(true);
  });
});
