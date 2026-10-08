import { test, expect } from '../fixtures/auth';

import { openResourceByName } from '../fixtures/discover';
/**
 * Smoke test: the delegated "Annotate References" flow dispatches a
 * `mark` job of the linking motivation **and the resulting reference
 * annotations are actually persisted.**
 *
 * The production chain is:
 *
 *   ReferencesPanel delegate widget → click "Annotate" (✨)
 *     → eventBus `mark:delegate-request` (local)
 *     → mark-state-unit → `client.mark.delegate(...)`
 *     → bus `job:create` (jobType="mark", params.motivation="linking" + params.entityTypes)
 *     → bus `job:created` (jobId)
 *     → worker entity-extraction → `mark:added` per entity
 *     → SSE → BrowseNamespace cache invalidation → references render.
 *
 * Two assertion levels:
 *   1. **Dispatch** (fast): `job:create` →
 *      `job:created` — the chip-selected entity type reaches the wire.
 *   2. **Outcome**: after the delegated job runs, ≥1 reference annotation is
 *      **persisted** and survives a reload.
 *
 * Why the outcome assertion matters: the dispatch pair alone passes for a
 * worker that silently drops every extracted entity (JSON parse failure →
 * `return []`). This spec is the system-level guard (structured output from
 * the model, and an unreadable extraction failing the job instead of returning
 * `[]`); the deterministic one lives in the `@semiont/jobs` unit tests.
 *
 * Entity-type choice: **Concept**, not the "first chip" (= `Person`).
 * The seed this spec opens (Photosynthesis Overview) is Concept-dense, so the
 * extraction reliably yields references; Person/Location would
 * legitimately return zero on that doc and make the outcome flaky.
 *
 * Requires the seeded KB to have the default entity types (incl. Concept).
 */
test.describe('delegated reference detection', () => {
  test('selecting an entity type and clicking Annotate dispatches the job AND persists reference annotations', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);  // includes a real LLM entity-extraction round-trip

    // Pin the Concept-dense TEXT seed BY NAME. Discover's first card is
    // data-order-dependent: Discover is newest-first, the seed adds PDFs,
    // and specs 09/16 push freshly generated resources to the top — so
    // `.first()` can land on a PDF (no `.cm-content`, no Concept-dense prose).
    // Spec 08 pins its text seed, and specs 14/20 their PDFs, the same way.
    await openResourceByName(page, 'Photosynthesis Overview');

    // Baseline reference count — the KB accumulates across runs, so assert
    // growth, not an absolute. (Same property test 05 relies on.)
    const referenceEntries = page.locator('[data-type="reference"]');
    const refsBefore = await referenceEntries.count();

    // Enter annotate mode. The References-panel's "Annotate References"
    // delegate section only renders in annotate mode.
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();
    await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 15_000 });

    // Right sidebar → Annotations → References sub-tab, so the delegate
    // section is in the DOM.
    await page.getByRole('button', { name: /^annotations$/i }).click();
    const referencesTab = page.getByRole('button', { name: '🔵', exact: true });
    await expect(referencesTab).toBeVisible({ timeout: 10_000 });
    if ((await referencesTab.getAttribute('aria-pressed')) !== 'true') {
      await referencesTab.click();
    }

    // Expand the "Annotate References" collapsible (label has a trailing "›").
    const main = page.getByRole('main');
    const delegateToggle = main.getByRole('button', { name: /annotate references/i }).first();
    await expect(delegateToggle).toBeVisible({ timeout: 10_000 });
    if ((await delegateToggle.getAttribute('aria-expanded')) !== 'true') await delegateToggle.click();

    // Select the **Concept** entity-type chip (reliably present in the
    // Photosynthesis seed text — see docstring). Among the default types
    // only "Concept" matches /concept/i, so the filter is unambiguous.
    const conceptChip = page
      .locator('.semiont-delegate-widget__chips .semiont-chip--selectable')
      .filter({ hasText: /concept/i });
    await expect(conceptChip).toBeVisible({ timeout: 10_000 });
    await conceptChip.click();
    await expect(conceptChip).toHaveAttribute('data-selected', 'true');

    bus.clear();

    // Click "Annotate" (✨) — scoped by data attrs to the reference delegate
    // section so we don't hit an identically-labeled button elsewhere.
    const submitBtn = page.locator('button[data-variant="delegate"][data-type="reference"]');
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // (1) Dispatch — the delegated job crossed the wire as a `mark` job of the
    // linking motivation and the gateway acked.
    const { request } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);
    expect(request.channel).toBe('job:create');

    // (2) Outcome — wait for the extracted references to actually persist
    // and render. Poll (rather than wait on a finish event) so we tolerate
    // the LLM round-trip + SSE delivery latency. A worker that silently
    // drops its extraction (→ return []) leaves this at the baseline.
    await expect
      .poll(async () => referenceEntries.count(), { timeout: 90_000 })
      .toBeGreaterThan(refsBefore);

    // Persistence across reload.
    const url = page.url();
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(async () => referenceEntries.count(), { timeout: 30_000 })
      .toBeGreaterThan(refsBefore);
  });
});
