import { test, expect } from '../fixtures/auth';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';
import { SemiontClient } from '@semiont/sdk';

/**
 * Render-time verbatim re-anchoring (ROBUST-RENDER.md).
 *
 * The annotation's two W3C selectors can disagree when the offset goes
 * stale — content shifted after the annotation was written — but the
 * quote text is still present verbatim. The renderer's job is to
 * re-anchor to the verbatim quote match, not to draw at the stale
 * offset. This is the one safe piece of render-time cleverness.
 *
 * We craft exactly that situation through the API (the manual
 * `mark:create-request` path persists client-supplied selectors
 * verbatim — no offset reconciliation), then assert the rendered
 * CodeMirror highlight covers the quote text, not the stale-offset text.
 *
 * Before the anchoring rewrite, the renderer trusted TextPositionSelector
 * and would have highlighted the off-by-two span. After it, the verbatim
 * `unique-occurrence` match wins.
 */

// Content with a single, unambiguous occurrence of the quote text.
// "quick brown fox" begins at offset 21:
//   "Padding pad pad. The " == 21 chars
const CONTENT = 'Padding pad pad. The quick brown fox jumps over the lazy dog.';
const EXACT = 'quick brown fox';
const TRUE_START = CONTENT.indexOf(EXACT); // 21
const TRUE_END = TRUE_START + EXACT.length; // 36
// Deliberately stale: off by two. content.substring(19, 34) === "e quick brown f".
const STALE_START = TRUE_START - 2;
const STALE_END = TRUE_END - 2;

let resourceId = '';

test.beforeAll(async () => {
  // Sanity: the stale offset really does point at the wrong text, so the
  // test would fail if the renderer trusted the position selector.
  expect(CONTENT.substring(STALE_START, STALE_END)).not.toBe(EXACT);
  expect(CONTENT.substring(TRUE_START, TRUE_END)).toBe(EXACT);

  const client = await SemiontClient.signInHttp({
    baseUrl: BACKEND_URL,
    email: E2E_EMAIL,
    password: E2E_PASSWORD,
  });
  try {
    const storageUri = `file://e2e/stale-offset-${Date.now()}.txt`;
    const { resourceId: rid } = await client.yield.resource({
      name: 'Stale-offset re-anchor fixture',
      storageUri,
      file: Buffer.from(CONTENT, 'utf-8'),
      format: 'text/plain',
      language: 'en',
    });
    resourceId = rid as string;

    // Craft the highlight: stale TextPositionSelector + verbatim-unique
    // TextQuoteSelector. Highlights carry no body.
    await client.mark.annotation({
      motivation: 'highlighting',
      target: {
        source: resourceId,
        selector: [
          { type: 'TextPositionSelector', start: STALE_START, end: STALE_END },
          { type: 'TextQuoteSelector', exact: EXACT },
        ],
      },
    } as Parameters<typeof client.mark.annotation>[0]);
  } finally {
    client.dispose();
  }
});

test.describe('stale-offset re-anchor', () => {
  test('renderer anchors a highlight to the verbatim quote, not the stale offset', async ({ signedInPage: page }) => {
    expect(resourceId).not.toBe('');

    await page.goto(`/en/know/resource/${encodeURIComponent(resourceId)}`);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Switch to annotate mode (CodeMirror) — that's the render path the
    // anchoring + decoration changes live in.
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();

    const cmContent = page.locator('.cm-content').first();
    await expect(cmContent).toBeVisible({ timeout: 15_000 });

    // The highlight decoration carries data-annotation-type="highlight".
    // Its rendered text must be the verbatim quote (re-anchored), not the
    // stale-offset slice. CodeMirror may split a decoration across spans;
    // join their text and assert it equals the quote.
    const highlightSpans = cmContent.locator('[data-annotation-type="highlight"]');
    await expect(highlightSpans.first()).toBeVisible({ timeout: 15_000 });

    const highlightedText = (await highlightSpans.allInnerTexts()).join('');
    expect(highlightedText).toBe(EXACT);
    // And explicitly NOT the off-by-two slice the stale offset points at.
    expect(highlightedText).not.toBe(CONTENT.substring(STALE_START, STALE_END));
  });
});
