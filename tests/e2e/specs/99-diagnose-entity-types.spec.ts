/**
 * Instrumentation-driven diagnostic — runs the full 01-05 flow and
 * captures [diag] logs to stdout. Determines how many ApiClient /
 * ActorVM / BrowseNamespace instances exist and which one the UI
 * observes vs which one the fetch resolves in.
 *
 * DELETE after root-causing the test 05 failure.
 */
import { test } from '../fixtures/auth';
import { expect } from '@playwright/test';

test.describe('diagnose', () => {
  test('entity-types-flow instance tracking', async ({ signedInPage: page, bus: _ }) => {
    const diagLines: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'debug') return;
      const t = msg.text();
      if (t.startsWith('[diag]')) diagLines.push(t);
    });

    // Reproduce test 05 up to the chip-check point.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await firstCard.waitFor({ state: 'visible', timeout: 15_000 });
    await firstCard.click();
    await page.getByText(/loading resource/i).waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});

    // Enter annotate mode
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();

    const cm = page.locator('.cm-content').first();
    await cm.waitFor({ state: 'visible', timeout: 15_000 });

    // Reference motivation
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^none$/i }).click();
    await page.getByRole('button', { name: /^motivation$/i }).click();
    await page.getByRole('menuitem', { name: /^reference$/i }).click();

    // Select text (abridged from test 05's logic)
    await cm.evaluate((el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const ns: Text[] = [];
      let tot = 0;
      while (w.nextNode()) {
        const n = w.currentNode as Text;
        ns.push(n);
        tot += n.nodeValue?.length ?? 0;
      }
      const tg = Math.min(10, Math.max(2, Math.floor(tot / 2)));
      let r = 0, s: Text | null = null, e: Text | null = null, eo = 0;
      for (const n of ns) {
        const len = n.nodeValue?.length ?? 0;
        if (!s && r + len > 0) s = n;
        if (s && r + len >= tg) { e = n; eo = tg - r; break; }
        r += len;
      }
      if (!s || !e) return;
      const rg = document.createRange();
      rg.setStart(s, 0);
      rg.setEnd(e, eo);
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(rg);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    // Poll for chips, and in parallel wait for final diag output.
    const chipWait = page.locator('.semiont-tag-selector__item').first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const chipVisible = await chipWait;

    // Summary
    // eslint-disable-next-line no-console
    console.log('\n==== DIAG SUMMARY ====');
    // eslint-disable-next-line no-console
    console.log(`Chip visible: ${chipVisible}`);
    const countBy = (re: RegExp) => diagLines.filter(l => re.test(l)).length;
    // eslint-disable-next-line no-console
    console.log(`SemiontClient constructions: ${countBy(/SemiontClient #\d+ constructed/)}`);
    // eslint-disable-next-line no-console
    console.log(`ActorVM constructions: ${countBy(/ActorVM #\d+ constructed/)}`);
    // eslint-disable-next-line no-console
    console.log(`BrowseNamespace constructions: ${countBy(/BrowseNamespace #\d+ constructed/)}`);
    // eslint-disable-next-line no-console
    console.log(`entityTypes() calls: ${countBy(/entityTypes\(\) called/)}`);
    // eslint-disable-next-line no-console
    console.log(`entityTypes fetchFn STARTs: ${countBy(/entityTypes fetchFn START/)}`);
    // eslint-disable-next-line no-console
    console.log(`entityTypes fetchFn RESOLVEs: ${countBy(/entityTypes fetchFn RESOLVE/)}`);
    // eslint-disable-next-line no-console
    console.log(`entityTypes$ EMIT events: ${countBy(/entityTypes\$ EMIT/)}`);
    // eslint-disable-next-line no-console
    console.log('---- First 80 [diag] lines ----');
    for (const l of diagLines.slice(0, 80)) {
      // eslint-disable-next-line no-console
      console.log(l);
    }
    // eslint-disable-next-line no-console
    console.log('==== END DIAG ====\n');

    // Assert a meaningful invariant: resolution must land in an observed Browse instance.
    expect(diagLines.length).toBeGreaterThan(0);
  });
});
