import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: manual highlight annotation round-trips through the full
 * bus gateway + persistence pipeline.
 *
 * Regression target: the earlier `mark:create-request`-scoped-to-resource
 * bug (silent emit to dead channel, handler never fired, no annotation
 * persisted). If this test passes, the full chain is working:
 * selection → mark:select-* → pendingAnnotation → mark:submit →
 * client.mark.annotation → actor.emit(mark:create-request) →
 * annotation-assembly handler → mark:create → Stower → mark:added →
 * back to UI via SSE.
 *
 * Also validates persistence: a reload should still show the highlight.
 */
test.describe('manual highlight', () => {
  // TODO: the current implementation races against CodeMirror's async
  // mount + highlight-panel auto-submit timing, and the content-area
  // selector (`.cm-content, .semiont-rendered-content, article`) doesn't
  // reliably match across resource formats. The test correctly guards
  // the "mark:create-request dispatched, persisted, renders" chain in
  // principle, but needs:
  //   - a stable content-area `data-testid` on the resource viewer,
  //   - a deterministic way to wait for the highlights panel to pick up
  //     the new annotation (rather than a class-prefix count),
  //   - a reliable way to verify persistence across reload.
  // Unit coverage of the same pipeline is in make-meaning stower tests;
  // e2e will catch the full cross-layer case once the selectors stabilize.
  test.skip('selecting text and confirming produces a persisted highlight', async ({ signedInPage: page }) => {
    // Open the first resource via Discover.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Enter annotate mode if a toggle is present. The annotator button
    // is part of the viewer chrome; its accessible name varies by i18n.
    // Search for a button whose name matches "annotate" (case-insensitive).
    // It's fine if the test environment already has annotate mode on
    // (first-selection semantics are the same either way).
    const annotateToggle = page.getByRole('button', { name: /annotate/i }).first();
    if (await annotateToggle.isVisible().catch(() => false)) {
      const pressed = await annotateToggle.getAttribute('aria-pressed');
      if (pressed !== 'true') await annotateToggle.click();
    }

    // Pick highlighting motivation. In the references / annotate chrome,
    // the highlight selector button has an accessible name containing
    // "highlight". If the UI is already in highlight mode this is a no-op.
    const highlightButton = page.getByRole('button', { name: /^highlight/i }).first();
    if (await highlightButton.isVisible().catch(() => false)) {
      await highlightButton.click();
    }

    // Find the main content container. CodeMirror renders under
    // .cm-content; Markdown/HTML under .semiont-rendered-content. Prefer
    // the first text-bearing element.
    const contentArea = page.locator('.cm-content, .semiont-rendered-content, article').first();
    await expect(contentArea).toBeVisible({ timeout: 10_000 });

    // Get the text and pick a small slice to select. Avoid the first few
    // characters (often whitespace/front-matter).
    const textContent = (await contentArea.textContent()) ?? '';
    expect(textContent.length).toBeGreaterThan(20);

    // Perform a selection via the browser's selection API. Works across
    // CodeMirror, rendered HTML, and plain text.
    await contentArea.evaluate((el, text) => {
      const selection = window.getSelection();
      if (!selection) throw new Error('no selection API');
      const range = document.createRange();
      // Find the first text node and select a stable substring.
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let totalOffset = 0;
      const targetStart = 10;
      const targetLen = 8;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const len = node.nodeValue?.length ?? 0;
        if (!startNode && totalOffset + len > targetStart) {
          startNode = node;
          startOffset = targetStart - totalOffset;
        }
        if (startNode && totalOffset + len >= targetStart + targetLen) {
          endNode = node;
          endOffset = (targetStart + targetLen) - totalOffset;
          break;
        }
        totalOffset += len;
      }
      if (!startNode || !endNode) throw new Error('selection targets not found');
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      selection.removeAllRanges();
      selection.addRange(range);
      // Fire a mouseup so the app's selection listener picks it up.
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      // Suppress the unused-text lint — we just needed the value.
      void text;
    }, textContent);

    // Highlights auto-submit when pendingAnnotation arrives with
    // motivation='highlighting' (see HighlightPanel useEffect). Wait for
    // the persisted annotation to appear in the highlights list.
    // The highlights panel exposes entries; count should go from 0 to ≥1
    // (or existing count + 1).
    // The simplest observable: the text we selected should now be wrapped
    // in a highlight marker. Use .semiont-annotation-mark or similar.
    // If no such class is used, fall back to "annotation count increased"
    // by checking the highlights panel text.
    //
    // We give this 30s — the full pipeline includes network + persist.
    await expect.poll(
      async () => (await page.locator('[class*="highlight"]').count()) > 0,
      { timeout: 30_000 },
    ).toBe(true);

    const urlBeforeReload = page.url();

    // Persistence check: reload and confirm the highlight is still there.
    await page.reload();
    await expect(page).toHaveURL(urlBeforeReload);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
    await expect.poll(
      async () => (await page.locator('[class*="highlight"]').count()) > 0,
      { timeout: 30_000 },
    ).toBe(true);
  });
});
