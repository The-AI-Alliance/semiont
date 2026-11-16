import { test, expect, type BusLogCapture } from '../fixtures/auth';
import type { Page } from '@playwright/test';
import { openResourceByName } from '../fixtures/discover';

/**
 * Smoke test: creating a reference-annotation by hand round-trips through the
 * bus and is persisted — with an entity type, and without one.
 *
 * This exercises the same "selection → pendingAnnotation → mark:submit
 * → client.mark.annotation() → mark:create-request" chain as test 04
 * (highlights), but with:
 *
 *   - motivation = 'linking' (rather than 'highlighting'), which routes
 *     the pending annotation into ReferencesPanel's inline prompt rather
 *     than HighlightPanel's auto-submit.
 *   - a body containing the selected entity type(s), tagged with
 *     `purpose: 'tagging'` — or NO body at all when no type is picked. See
 *     ReferencesPanel.handleCreateReference for the exact payload shape.
 *
 * Regression targets:
 *   - the reference-creation path breaking without the highlight path also
 *     breaking (e.g. if the tag selector chip stops feeding
 *     `pendingEntityTypes` into the mark:submit body, the UI appears to work
 *     but the reference is untagged);
 *   - **the untagged path breaking on its own.** Entity types are optional,
 *     but `MarkSubmitEvent.body` is `minItems: 1`, so an empty selection must
 *     OMIT `body` rather than send `[]`. Sending `[]` 400s at `/bus/emit`, and
 *     `mark.submit` is fire-and-forget — so the failure is silent and the
 *     button simply looks inert. That shipped, and survived, precisely because
 *     the only test here picked a type. Found live 2026-08-24.
 *
 * Requires the seeded KB to have ≥1 entity type defined; the resource
 * must have at least 2 characters of selectable text.
 */

// A NAMED text seed — see 04 for why "first card" is not safe here.
// CodeMirror mounts only for text-bearing resources, and Discover's
// newest-first order makes the first card's media type incidental.
// Deliberately the same seed as 04: these two shared a resource under the
// old first-card lookup, and spec 09 hunts for the unresolved references
// this test leaves behind.
const SEED = 'Quantum Computing Primer';

/**
 * Enter annotate mode with motivation=Reference and select some text, leaving
 * the ReferencesPanel inline prompt open.
 *
 * Returns the reference-entry locator and its pre-selection count, so the
 * caller can assert growth.
 */
async function selectTextInReferenceMode(page: Page, bus: BusLogCapture, startAt = 0) {
  await openResourceByName(page, SEED);

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
  // "test2" give us 5 chars; real resources give us more. `startAt` lets the
  // two tests anchor DIFFERENT ranges, so neither depends on whether the
  // backend accepts two references over identical text.
  await cmContent.evaluate((el, from) => {
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
    // Clamp: a short resource may not reach `from` at all, in which case fall
    // back to the head rather than failing on an offset the seed cannot honour.
    const begin = Math.min(from, Math.max(0, totalChars - 2));
    const targetLen = Math.min(10, Math.max(2, Math.floor((totalChars - begin) / 2)));
    const end = begin + targetLen;

    /** Resolve an absolute character offset to a (node, offset) pair. */
    const locate = (target: number): { node: Text; offset: number } | null => {
      let running = 0;
      for (const node of textNodes) {
        const len = node.nodeValue?.length ?? 0;
        if (running + len >= target) return { node, offset: target - running };
        running += len;
      }
      return null;
    };

    const start = locate(begin);
    const stop = locate(end);
    if (!start || !stop) throw new Error('walker could not resolve selection boundaries');
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(stop.node, stop.offset);
    const sel = window.getSelection();
    if (!sel) throw new Error('no Selection API');
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, startAt);

  return { referenceEntries, refsBefore };
}

/**
 * Click "Create Reference" — the primary action button inside the
 * pending-reference prompt. The visible label is prefixed with a
 * 🔗 emoji, so `^create reference$` with anchors would not match;
 * use a substring regex instead.
 */
async function createReference(page: Page) {
  await page.getByRole('button', { name: /create reference/i }).click();
}

test.describe('manual reference', () => {
  test('selecting text in annotate+reference mode with an entity type creates a persisted reference', async ({ signedInPage: page, bus }) => {
    const { referenceEntries, refsBefore } = await selectTextInReferenceMode(page, bus);

    // The ReferencesPanel inline prompt renders once a pendingAnnotation
    // with motivation='linking' appears. Within it, `.semiont-tag-selector__item`
    // buttons are per-entity-type chips. Pick the first available type.
    const tagChips = page.locator('.semiont-tag-selector__item');
    await expect(tagChips.first()).toBeVisible({ timeout: 10_000 });
    const firstChip = tagChips.first();
    await firstChip.click();
    await expect(firstChip).toHaveAttribute('data-selected', 'true');

    await createReference(page);

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

  test('creating a reference with NO entity type selected is accepted, not silently refused', async ({ signedInPage: page, bus }) => {
    // Offset past the range the first test claims, so the two never contend.
    const { referenceEntries, refsBefore } = await selectTextInReferenceMode(page, bus, 40);

    // Wait for the prompt, then touch NOTHING. Entity types are optional and
    // this is the path that says so.
    const tagChips = page.locator('.semiont-tag-selector__item');
    await expect(tagChips.first()).toBeVisible({ timeout: 10_000 });
    await expect(tagChips.first(), 'no type is pre-selected').toHaveAttribute('data-selected', 'false');

    await createReference(page);

    // The whole point. With `body: []` this never arrived: `/bus/emit`
    // answered 400 ("must NOT have fewer than 1 items") and the fire-and-forget
    // submit swallowed it, so the only visible symptom was nothing happening.
    await bus.expectRequestResponse('mark:create-request', 'mark:create-ok', 30_000);

    await expect
      .poll(async () => referenceEntries.count(), { timeout: 30_000 })
      .toBeGreaterThan(refsBefore);
  });
});
