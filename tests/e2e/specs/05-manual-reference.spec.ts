import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: creating a reference-annotation by hand, tagged with an
 * entity type, round-trips through the bus and is persisted.
 *
 * This exercises the same "selection → pendingAnnotation → mark:submit
 * → client.mark.annotation() → mark:create-request" chain as test 04
 * (highlights), but with:
 *
 *   - motivation = 'linking' (rather than 'highlighting'), which routes
 *     the pending annotation into ReferencesPanel's inline prompt rather
 *     than HighlightPanel's auto-submit.
 *   - a body containing the selected entity type(s), tagged with
 *     `purpose: 'tagging'`. See ReferencesPanel.handleCreateReference
 *     for the exact payload shape.
 *
 * Regression target: the reference-creation path breaking without the
 * highlight path also breaking (e.g. if the tag selector chip stops
 * feeding `pendingEntityTypes` into the mark:submit body, the UI appears
 * to work but the reference is untagged).
 *
 * Requires the seeded KB to have ≥1 entity type defined; the resource
 * must have at least 2 characters of selectable text.
 */
test.describe('manual reference', () => {
  test('selecting text in annotate+reference mode with an entity type creates a persisted reference', async ({ signedInPage: page, bus }) => {
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Baseline reference count for growth assertion.
    const referenceEntries = page.locator('[data-type="reference"]');
    const refsBefore = await referenceEntries.count();

    bus.clear();

    // Enter annotate mode. Browse mode renders plain HTML; annotate
    // mode mounts CodeMirror (needed for programmatic selection).
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();

    const cmContent = page.locator('.cm-content').first();
    await expect(cmContent).toBeVisible({ timeout: 15_000 });

    // Switch motivation to Reference (the UI label for the 'linking'
    // motivation — see AnnotateToolbar + en.json).
    //
    // The Motivation menuitem behavior is TOGGLE — clicking the
    // currently-selected motivation clears it to None. The toolbar
    // persists the selection to localStorage, so previous runs may
    // leave it already on "Reference" and a direct click would
    // toggle it off. Reset to None first, then set to Reference.
    // This makes the test deterministic regardless of prior state.
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^none$/i }).click();
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^reference$/i }).click();
    // Confirm the toolbar picked it up before proceeding.
    await expect(
      page.getByRole('button', { name: /^motivation$/i }).filter({ hasText: /reference/i })
    ).toBeVisible({ timeout: 5_000 });

    // Adaptive selection — same shape as test 04. Short resources like
    // "test2" give us 5 chars; real resources give us more.
    await cmContent.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      let totalChars = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        textNodes.push(node);
        totalChars += node.nodeValue?.length ?? 0;
      }
      if (totalChars < 2) {
        throw new Error(`content area has only ${totalChars} chars; cannot select`);
      }
      const targetLen = Math.min(10, Math.max(2, Math.floor(totalChars / 2)));
      let running = 0;
      let startNode: Text | null = null;
      let startOff = 0;
      let endNode: Text | null = null;
      let endOff = 0;
      for (const node of textNodes) {
        const len = node.nodeValue?.length ?? 0;
        if (!startNode && running + len > 0) { startNode = node; startOff = 0; }
        if (startNode && running + len >= targetLen) {
          endNode = node;
          endOff = targetLen - running;
          break;
        }
        running += len;
      }
      if (!startNode || !endNode) throw new Error('walker could not resolve selection boundaries');
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      const sel = window.getSelection();
      if (!sel) throw new Error('no Selection API');
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // The ReferencesPanel inline prompt renders once a pendingAnnotation
    // with motivation='linking' appears. Within it, `.semiont-tag-selector__item`
    // buttons are per-entity-type chips. Pick the first available type.
    const tagChips = page.locator('.semiont-tag-selector__item');
    await expect(tagChips.first()).toBeVisible({ timeout: 10_000 });
    const firstChip = tagChips.first();
    await firstChip.click();
    await expect(firstChip).toHaveAttribute('data-selected', 'true');

    // Click "Create Reference" — the primary action button inside the
    // pending-reference prompt. The visible label is prefixed with a
    // 🔗 emoji, so `^create reference$` with anchors would not match;
    // use a substring regex instead.
    await page.getByRole('button', { name: /create reference/i }).click();

    // Protocol-level proof: the create chain round-tripped. This is the
    // same guarantee test 04 asserts for highlights.
    await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

    // UI-level growth: the references list grew. Exact DOM-count is not
    // asserted — one logical reference may render as several nodes with
    // `data-type="reference"` (the list entry and any inline markers).
    await expect
      .poll(async () => referenceEntries.count(), { timeout: 30_000 })
      .toBeGreaterThan(refsBefore);

    // Persistence: reload and confirm the reference still renders.
    const urlBeforeReload = page.url();
    await page.reload();
    await expect(page).toHaveURL(urlBeforeReload);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    await expect
      .poll(async () => referenceEntries.count(), { timeout: 30_000 })
      .toBeGreaterThan(refsBefore);
  });
});
