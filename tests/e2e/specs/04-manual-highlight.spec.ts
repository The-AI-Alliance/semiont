import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: manual highlight annotation round-trips through the full
 * bus-gateway + persistence pipeline and survives a reload.
 *
 * Regression target: the earlier `mark:create-request`-scoped-to-resource
 * bug and the `mark:create-ok` optimistic-emit bug. If this test passes,
 * the full chain is working: selection → mark:requested → pendingAnnotation
 * → mark:submit → client.mark.annotation → actor.emit(mark:create-request)
 * → annotation-assembly handler → mark:create → Stower appendEvent →
 * mark:added domain event → SSE → BrowseNamespace cache invalidation →
 * annotations refetch → UI re-renders with the new highlight.
 */
test.describe('manual highlight', () => {
  test('selecting text in annotate+highlight mode produces a persisted highlight', async ({ signedInPage: page, bus }) => {
    // Open the first resource via Discover.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Wait for CodeMirror to mount the content area. `.cm-content` is
    // created asynchronously after the resource data arrives.
    const cmContent = page.locator('.cm-content').first();
    await expect(cmContent).toBeVisible({ timeout: 15_000 });

    // Baseline: how many highlights are already present? (Fixtures may
    // leave some from prior runs.)
    const highlightEntries = page.locator('[data-type="highlight"]');
    const highlightsBefore = await highlightEntries.count();

    bus.clear();  // Only care about traffic from the highlight action onward.

    // Enter annotate mode via the toolbar. The Mode dropdown's trigger
    // has accessible name "Mode"; inside it, the "Annotate" menuitem
    // is what we want. Clicks on the trigger pin the dropdown open.
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();

    // Pick the Highlight motivation so pendingAnnotation auto-submits.
    // Dropdown trigger: "Motivation". Menuitem: "Highlight".
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^highlight$/i }).click();

    // Select a slice of text inside CodeMirror's content area. We use
    // the DOM Selection API and then fire mouseup so AnnotateView's
    // listener picks the selection up (see AnnotateView.tsx mouseup
    // handler at the time of writing).
    await cmContent.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let total = 0;
      const targetStart = 10;
      const targetLen = 12;
      let startNode: Text | null = null;
      let startOff = 0;
      let endNode: Text | null = null;
      let endOff = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const len = node.nodeValue?.length ?? 0;
        if (!startNode && total + len > targetStart) {
          startNode = node;
          startOff = targetStart - total;
        }
        if (startNode && total + len >= targetStart + targetLen) {
          endNode = node;
          endOff = (targetStart + targetLen) - total;
          break;
        }
        total += len;
      }
      if (!startNode || !endNode) {
        throw new Error('not enough text in content area for selection');
      }
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      const sel = window.getSelection();
      if (!sel) throw new Error('no Selection API');
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // Protocol-level proof: the create chain round-tripped successfully.
    // HighlightPanel auto-submits when `pendingAnnotation.motivation ===
    // 'highlighting'` → mark-vm calls client.mark.annotation() → actor
    // emits `mark:create-request` → backend assembly+stower → mark:create-ok
    // with matching cid. This is the chain that the earlier scope bug
    // (emit routed to dead subject) and the optimistic-ack bug (mark:
    // create-ok fired before persistence) both broke.
    await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

    // UI-level confirmation: the highlight is rendered in the panel.
    await expect
      .poll(async () => highlightEntries.count(), { timeout: 30_000 })
      .toBeGreaterThan(highlightsBefore);

    const highlightsAfterCreate = await highlightEntries.count();
    expect(highlightsAfterCreate).toBe(highlightsBefore + 1);

    // Persistence check: reload and confirm the new highlight is still
    // there. The count should match what we saw after creating.
    const urlBeforeReload = page.url();
    await page.reload();
    await expect(page).toHaveURL(urlBeforeReload);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    await expect
      .poll(async () => highlightEntries.count(), { timeout: 30_000 })
      .toBe(highlightsAfterCreate);
  });
});
