import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: hovering an annotation fires `beckon:hover` on the bus
 * and BeckonStateUnit reacts by firing `beckon:sparkle`.
 *
 * Regression target (VMs-from-Session Stage D): `createBeckonStateUnit` was
 * migrated from `(eventBus)` to `(client)` and internally rewired from
 * `eventBus.get('beckon:hover').subscribe(...)` to
 * `client.stream('beckon:hover').subscribe(...)` and from
 * `eventBus.get(...).next(...)` to `client.emit(...)`. If the factory's
 * internal bus wiring regressed, the hover would still fire `beckon:hover`
 * (because the component uses `session.client.emit` directly) but the
 * state unit would never see it and the `beckon:sparkle` reaction would be
 * silent. Observing both events on the bus confirms the factory is
 * subscribing on the same bus the component is emitting to.
 *
 * Self-setup: this spec creates its own annotation if the chosen
 * resource has none. Previously it depended on specs 04/05 having run
 * first and created annotations in the lex-ordering window. Self-setup
 * removes that ordering coupling — the spec runs cleanly in isolation.
 */
test.describe('hover → beckon', () => {
  test('hovering an annotation fires beckon:hover and BeckonStateUnit fires beckon:sparkle', async ({ signedInPage: page, bus }) => {
    // Open the first resource on Discover. Either it already has an
    // annotation in BrowseView (subsequent run, or a prior spec left
    // one) — or we'll create one ourselves below.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Annotations render as `[data-annotation-id]` inside BrowseView's
    // container. The `.semiont-browse-view`-scoped locator is load-
    // bearing — `[data-annotation-id]` also appears in the references
    // panel, but only BrowseView has the mouseover handler bound that
    // fires `beckon:hover`.
    const annLocator = page.locator('.semiont-browse-view [data-annotation-id]').first();

    const alreadyHas = await annLocator.isVisible({ timeout: 2_000 }).catch(() => false);

    if (!alreadyHas) {
      // ── Self-setup: create a highlight on this resource ────────────
      //
      // Mirrors spec 04's manual-highlight setup. We use the
      // `highlighting` motivation specifically (NOT `linking`/reference)
      // because highlights have no body and no target — the simplest
      // annotation shape that produces a hoverable
      // `[data-annotation-id]` in BrowseView. The hover test cares
      // that *some* annotation is present, not what kind.
      await page.getByRole('button', { name: /^mode$/i }).click();
      await page.getByRole('menuitem', { name: /^annotate$/i }).click();

      const cmContent = page.locator('.cm-content').first();
      await expect(cmContent).toBeVisible({ timeout: 15_000 });

      // Reset motivation to None then pick Highlight, so the test is
      // deterministic regardless of localStorage-persisted state from
      // earlier sessions.
      await page.getByRole('button', { name: /^motivation$/i }).click();
      await page.getByRole('menuitem', { name: /^none$/i }).click();
      await page.getByRole('button', { name: /^motivation$/i }).click();
      await page.getByRole('menuitem', { name: /^highlight$/i }).click();
      await expect(
        page.getByRole('button', { name: /^motivation$/i }).filter({ hasText: /highlight/i })
      ).toBeVisible({ timeout: 5_000 });

      // Select a small slice of text in CodeMirror's content area. The
      // selection target needs to land in *body text* — not markdown
      // syntax — so BrowseView's source→rendered offset mapping can
      // resolve it after reload. Markdown headers ("# Title") are
      // consumed by the renderer; characters inside them have no
      // corresponding position in the rendered DOM and produce a
      // persisted-but-invisible annotation. (Spec 04 doesn't hit this
      // because it asserts via the sidebar `[data-type="highlight"]`
      // entry, which renders regardless; spec 08 needs the in-content
      // overlay because that's where the hover handler is bound.)
      //
      // Strategy: skip past the first paragraph break (`\n\n`) and
      // select 10 chars of body text. Seeded content has the shape
      // `# Heading\n\nBody…` so the first `\n\n` lands us at the start
      // of the first body paragraph.
      //
      // HighlightPanel auto-submits on selection when motivation is
      // `highlighting`, so this single mouseup completes the create
      // round-trip without further clicks.
      await cmContent.evaluate((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const textNodes: Text[] = [];
        let fullText = '';
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          textNodes.push(node);
          fullText += node.nodeValue ?? '';
        }
        const breakIdx = fullText.indexOf('\n\n');
        const targetStart = breakIdx >= 0 ? breakIdx + 2 : Math.floor(fullText.length / 2);
        const targetLen = Math.min(10, Math.max(2, fullText.length - targetStart - 1));
        if (targetLen < 2) {
          throw new Error(`content too short to select past header: len=${fullText.length}, start=${targetStart}`);
        }

        let running = 0;
        let startNode: Text | null = null;
        let endNode: Text | null = null;
        let startOff = 0;
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
        if (!startNode || !endNode) throw new Error('selection boundary resolution failed');
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        const sel = window.getSelection();
        if (!sel) throw new Error('no Selection API');
        sel.removeAllRanges();
        sel.addRange(range);
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });

      // Wait for the create round-trip to land — annotation persisted.
      await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

      // Switch back to browse mode. The toolbar persists the mode to
      // localStorage, so a plain reload would come back up in annotate
      // mode (CodeMirror) rather than browse mode (ReactMarkdown +
      // overlay). The hover handler is bound only on BrowseView's
      // `.semiont-browse-view` container, so we need that renderer
      // mounted.
      await page.getByRole('button', { name: /^mode$/i }).click();
      await page.getByRole('menuitem', { name: /^browse$/i }).click();
    }

    // Either way (pre-existing or just-created), there's now a
    // `[data-annotation-id]` in BrowseView. Wait for it to render.
    await expect(annLocator).toBeVisible({ timeout: 15_000 });

    // ── The actual test: hover, assert beckon round-trip ───────────────
    bus.clear();

    // Playwright's `hover()` fires the mouseenter that kicks off the
    // 150ms delay before `beckon:hover` is emitted.
    await annLocator.hover();

    // BeckonStateUnit chain: `beckon:hover` emitted → state unit
    // subscribes via `client.stream('beckon:hover')` → on non-null
    // annotationId, emits `beckon:sparkle`. Both should appear on the
    // bus. If only `beckon:hover` is observed, the state unit isn't
    // subscribed to the same bus the component is emitting on
    // (regression target — see header).
    await bus.waitForEmit('beckon:hover', { timeout: 5_000 });
    await bus.waitForEmit('beckon:sparkle', { timeout: 5_000 });
  });
});
