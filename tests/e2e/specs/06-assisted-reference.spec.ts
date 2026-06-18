import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: the AI-assisted "Annotate References" flow dispatches a
 * reference-annotation job **and the resulting reference annotations are
 * actually persisted.**
 *
 * The production chain is:
 *
 *   ReferencesPanel assist widget → click "Annotate" (✨)
 *     → eventBus `mark:assist-request` (local)
 *     → mark-state-unit → `client.mark.assist(...)`
 *     → namespaces/mark.ts `dispatchAssist`
 *     → bus `job:create` (jobType="reference-annotation" + params.entityTypes)
 *     → bus `job:created` (jobId)
 *     → worker entity-extraction → `mark:added` per entity
 *     → SSE → BrowseNamespace cache invalidation → references render.
 *
 * Two assertion levels:
 *   1. **Dispatch** (fast, original regression target): `job:create` →
 *      `job:created` — the chip-selected entity type reaches the wire.
 *   2. **Outcome** (Phase 3 of `entity-extraction-silent-drop.md`): after
 *      the assist runs, ≥1 reference annotation is **persisted** and
 *      survives a reload.
 *
 * Why the outcome assertion matters: the *previous* version of this spec
 * stopped at the dispatch pair, so a worker that silently dropped every
 * extracted entity (the `entity-extraction-silent-drop` bug — JSON parse
 * failure → `return []`) still passed. This spec is the system-level
 * guard for that fix (P1 tool-use + P2 de-silence); the deterministic RED
 * lives in the `@semiont/jobs` unit tests.
 *
 * Entity-type choice: **Concept**, not the "first chip" (= `Person`).
 * The seeded first resource (Photosynthesis) is Concept-dense, so the
 * extraction reliably yields references; Person/Location would
 * legitimately return zero on that doc and make the outcome flaky.
 *
 * Requires the seeded KB to have the default entity types (incl. Concept).
 */
test.describe('assisted reference detection', () => {
  test('selecting an entity type and clicking Annotate dispatches the job AND persists reference annotations', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);  // includes a real LLM entity-extraction round-trip

    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Baseline reference count — the KB accumulates across runs, so assert
    // growth, not an absolute. (Same property test 05 relies on.)
    const referenceEntries = page.locator('[data-type="reference"]');
    const refsBefore = await referenceEntries.count();

    // Enter annotate mode. The References-panel's "Annotate References"
    // assist section only renders in annotate mode.
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();
    await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 15_000 });

    // Right sidebar → Annotations → References sub-tab, so the assist
    // section is in the DOM.
    await page.getByRole('button', { name: /^annotations$/i }).click();
    const referencesTab = page.getByRole('button', { name: '🔵', exact: true });
    await expect(referencesTab).toBeVisible({ timeout: 10_000 });
    if ((await referencesTab.getAttribute('aria-pressed')) !== 'true') {
      await referencesTab.click();
    }

    // Expand the "Annotate References" collapsible (label has a trailing "›").
    const main = page.getByRole('main');
    const assistToggle = main.getByRole('button', { name: /annotate references/i }).first();
    await expect(assistToggle).toBeVisible({ timeout: 10_000 });
    if ((await assistToggle.getAttribute('aria-expanded')) !== 'true') await assistToggle.click();

    // Select the **Concept** entity-type chip (reliably present in the
    // Photosynthesis seed text — see docstring). Among the default types
    // only "Concept" matches /concept/i, so the filter is unambiguous.
    const conceptChip = page
      .locator('.semiont-assist-widget__chips .semiont-chip--selectable')
      .filter({ hasText: /concept/i });
    await expect(conceptChip).toBeVisible({ timeout: 10_000 });
    await conceptChip.click();
    await expect(conceptChip).toHaveAttribute('data-selected', 'true');

    bus.clear();

    // Click "Annotate" (✨) — scoped by data attrs to the reference assist
    // so we don't hit an identically-labeled button elsewhere.
    const submitBtn = page.locator('button[data-variant="assist"][data-type="reference"]');
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // (1) Dispatch — the assist crossed the wire as a reference-annotation
    // job and the backend acked. (jobType for `linking` is
    // `reference-annotation`; see namespaces/mark.ts jobTypeMap.)
    const { request } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);
    expect(request.channel).toBe('job:create');

    // (2) Outcome — wait for the extracted references to actually persist
    // and render. Poll (rather than wait on a finish event) so we tolerate
    // the LLM round-trip + SSE delivery latency. PRE-FIX this stayed at the
    // baseline (silent drop → return []); that is the regression guarded.
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
