import { test, expect } from '../fixtures/auth';
import type { Page, Locator } from '@playwright/test';

/**
 * Smoke test: AI-assisted (AI-directed) detection on a **text-layer PDF**
 * (#736 Phase 2 + #737 Phase 3).
 *
 * User-directed PDF annotation already round-trips (14-pdf-render.spec.ts).
 * This proves the *AI-directed* detection pipeline runs end-to-end on a PDF —
 * the worker extracts the PDF's text layer (`prepareDetection` →
 * `extractPdfTextLayer`), the model detects spans over that text, and the
 * shared geometry tail (`buildPdfAnnotation`) anchors each span to PDF
 * viewrects (FragmentSelector, RFC 3778). Those render on the PDF canvas as
 * <rect>s in the same SVG overlay 14 asserts on, and survive a reload.
 *
 * Two motivations, the two detection body shapes #737 calls out:
 *   - commenting → a generated TextualBody (density-gated),
 *   - linking    → an entity-reference body (entity extraction).
 * Both anchor through `buildPdfAnnotation`, so both surface as <rect>s; the
 * per-body-shape detail is covered deterministically by the @semiont/jobs unit
 * suites (prepareDetection fan-out + build-pdf-annotation).
 *
 * Seed dependency: `scripts/seed.ts` yields an `application/pdf` resource named
 * "Cellular Respiration PDF" — a ~346-word Concept-dense text-layer PDF. (The
 * "Spatial Smoke PDF" is 3 words: enough to render, too thin for detection to
 * reliably fire.)
 *
 * Real-LLM spec (like 06-assisted-reference): each test runs a live inference
 * round-trip, so it polls for the outcome with generous timeouts and asserts
 * <rect> *growth* (the KB accumulates across runs), never an absolute count.
 */

const PDF_CARD = /^open resource:\s*cellular respiration pdf/i;
const IMG = '.semiont-pdf-annotation-canvas__image';
const SVG = '.semiont-pdf-annotation-canvas__svg';

async function openPdfInAnnotateMode(page: Page) {
  await page.goto('/en/know/discover');
  // `.first()` — the seed accumulates duplicate PDF cards across runs (14's
  // note); any is an identical fresh fixture. The name filter keeps us off the
  // "Spatial Smoke PDF".
  const card = page.getByRole('button', { name: PDF_CARD }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

  // Annotate mode mounts PdfAnnotationCanvas; the SVG overlay mounts once the
  // page <img> + dimensions are measured (see 14-pdf-render).
  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();
  await expect(page.locator(IMG)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(SVG)).toBeVisible({ timeout: 15_000 });

  // Open the right-sidebar Annotations panel so the per-motivation assist
  // sections are in the DOM.
  await page.getByRole('button', { name: /^annotations$/i }).click();
}

// Annotations sub-tabs are icon-only buttons (aria-pressed) in the panel's tab
// strip; select by emoji, scoped to the strip so it can't collide elsewhere.
async function selectSubTab(page: Page, emoji: string) {
  const tab = page.locator('.semiont-unified-panel__tabs').getByRole('button', { name: emoji, exact: true });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  if ((await tab.getAttribute('aria-pressed')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

// After a live assist + SSE delivery, the detected annotations anchor to PDF
// viewrects and render as <rect>s on the canvas — reload and confirm they
// persist. Mirrors 14's persistence tail.
async function expectRectsPersist(page: Page, rects: Locator, before: number) {
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
  await page.getByRole('button', { name: /^mode$/i }).click();
  await page.getByRole('menuitem', { name: /^annotate$/i }).click();
  await expect(page.locator(SVG)).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => rects.count(), { timeout: 30_000 }).toBeGreaterThan(before);
}

test.describe('assisted detection on a text-layer PDF', () => {
  test('assisted commenting on a PDF dispatches, renders rect-anchored annotations, and persists', async ({ signedInPage: page, bus }) => {
    test.setTimeout(150_000); // includes a real LLM comment round-trip

    await openPdfInAnnotateMode(page);
    const rects = page.locator(`${SVG} rect`);
    const rectsBefore = await rects.count();

    // Comments sub-tab (💬) → expand "Annotate Comments".
    await selectSubTab(page, '💬');
    const main = page.getByRole('main');
    const toggle = main.getByRole('button', { name: /annotate comments/i }).first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();

    // Drop the density cap: the fixture is only ~346 words, so a "N per 2000
    // words" target rounds toward zero. Unchecked → no density guidance (the
    // prompt lets the passage decide), so the model comments on what's salient.
    const densityToggle = page.locator('input[type="checkbox"][data-variant="comment"]');
    if (await densityToggle.isChecked()) await densityToggle.uncheck();

    bus.clear();
    const submit = page.locator('button[data-variant="assist"][data-type="comment"]');
    await expect(submit).toBeEnabled({ timeout: 5_000 });
    await submit.click();

    // Dispatch — the assist crossed the wire as a comment-annotation job.
    const { request } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);
    expect(request.channel).toBe('job:create');

    // Outcome — detected comments anchor to PDF viewrects and render as <rect>s.
    // Poll for growth (LLM + SSE latency); PRE-#736 this job threw on a PDF.
    await expect.poll(async () => rects.count(), { timeout: 110_000 }).toBeGreaterThan(rectsBefore);

    await expectRectsPersist(page, rects, rectsBefore);
  });

  test('assisted linking on a PDF dispatches, renders rect-anchored references, and persists', async ({ signedInPage: page, bus }) => {
    test.setTimeout(150_000); // includes a real LLM entity-extraction round-trip

    await openPdfInAnnotateMode(page);
    const rects = page.locator(`${SVG} rect`);
    const rectsBefore = await rects.count();

    // References sub-tab (🔵) → expand "Annotate References".
    await selectSubTab(page, '🔵');
    const main = page.getByRole('main');
    const toggle = main.getByRole('button', { name: /annotate references/i }).first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();

    // Select the Concept entity-type chip — the respiration passage is
    // Concept-dense (glucose, ATP, mitochondria, …), so extraction reliably
    // yields references. Mirrors 06-assisted-reference's chip flow.
    const conceptChip = page
      .locator('.semiont-assist-widget__chips .semiont-chip--selectable')
      .filter({ hasText: /concept/i });
    await expect(conceptChip).toBeVisible({ timeout: 10_000 });
    await conceptChip.click();
    await expect(conceptChip).toHaveAttribute('data-selected', 'true');

    bus.clear();
    const submit = page.locator('button[data-variant="assist"][data-type="reference"]');
    await expect(submit).toBeEnabled({ timeout: 5_000 });
    await submit.click();

    // Dispatch — the assist crossed the wire as a reference-annotation job
    // (jobType for `linking`; see namespaces/mark.ts jobTypeMap).
    const { request } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);
    expect(request.channel).toBe('job:create');

    // Outcome — detected references anchor to PDF viewrects and render as <rect>s.
    await expect.poll(async () => rects.count(), { timeout: 110_000 }).toBeGreaterThan(rectsBefore);

    await expectRectsPersist(page, rects, rectsBefore);
  });
});
