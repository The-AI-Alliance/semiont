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

    // Baseline: how many highlights are already present? (Fixtures may
    // leave some from prior runs.)
    const highlightEntries = page.locator('[data-type="highlight"]');
    const highlightsBefore = await highlightEntries.count();

    bus.clear();  // Only care about traffic from the highlight action onward.

    // Switch to annotate mode via the toolbar. Browse mode renders the
    // resource as plain HTML; annotate mode swaps in CodeMirror, which
    // is what we need for programmatic selection. The Mode dropdown's
    // trigger has accessible name "Mode"; inside it, the "Annotate"
    // menuitem is what we want. Clicks on the trigger pin the dropdown
    // open.
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();

    // Now wait for CodeMirror to mount the content area. `.cm-content`
    // is created asynchronously once annotate mode takes effect.
    const cmContent = page.locator('.cm-content').first();
    await expect(cmContent).toBeVisible({ timeout: 15_000 });

    // Pick the Highlight motivation so pendingAnnotation auto-submits.
    //
    // Motivation menuitem behavior is TOGGLE — clicking the
    // currently-selected motivation clears it to None. The toolbar
    // persists the selection to localStorage, so previous runs may
    // leave it already on "Highlight" and a direct click would toggle
    // it off. Reset to None first, then select Highlight. Makes the
    // test deterministic regardless of prior state.
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^none$/i }).click();
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^highlight$/i }).click();
    await expect(
      page.getByRole('button', { name: /^motivation$/i }).filter({ hasText: /highlight/i })
    ).toBeVisible({ timeout: 5_000 });

    // Select a slice of text inside CodeMirror's content area. We use
    // the DOM Selection API and then fire mouseup so AnnotateView's
    // listener picks the selection up (see AnnotateView.tsx mouseup
    // handler at the time of writing).
    //
    // The selection window is adaptive: we aim for roughly the middle
    // of the content, but fall back to shorter spans when a seeded
    // resource has little text. Minimum selectable span is 2 chars.
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

      // Pick a span of up to 10 chars, at most half the content length,
      // starting from offset 0. This works for the tiny "test2" fixture
      // and for longer real-world resources.
      const targetLen = Math.min(10, Math.max(2, Math.floor(totalChars / 2)));
      const targetStart = 0;

      let running = 0;
      let startNode: Text | null = null;
      let startOff = 0;
      let endNode: Text | null = null;
      let endOff = 0;
      for (const node of textNodes) {
        const len = node.nodeValue?.length ?? 0;
        if (!startNode && running + len > targetStart) {
          startNode = node;
          startOff = targetStart - running;
        }
        if (startNode && running + len >= targetStart + targetLen) {
          endNode = node;
          endOff = (targetStart + targetLen) - running;
          break;
        }
        running += len;
      }
      if (!startNode || !endNode) {
        throw new Error('walker could not resolve selection boundaries');
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

    // UI-level confirmation: the highlight is rendered somewhere in
    // the DOM. A single logical highlight produces several matching
    // nodes (inline marker, sidebar entry, history row, summary count,
    // etc.) — exact count varies with the render. What we assert here
    // is growth: the count is strictly higher than the pre-action
    // baseline. Protocol-level correctness — exactly one create-request
    // with one create-ok — is already verified by expectRequestResponse
    // above.
    await expect
      .poll(async () => highlightEntries.count(), { timeout: 30_000 })
      .toBeGreaterThan(highlightsBefore);

    // Persistence check: reload and confirm the highlight still renders.
    // We reassert the same growth property, not exact equality — reloads
    // can legitimately change DOM-render counts (e.g. different panels
    // mount on cold load vs after in-session creation).
    const urlBeforeReload = page.url();
    await page.reload();
    await expect(page).toHaveURL(urlBeforeReload);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    await expect
      .poll(async () => highlightEntries.count(), { timeout: 30_000 })
      .toBeGreaterThan(highlightsBefore);
  });
});
