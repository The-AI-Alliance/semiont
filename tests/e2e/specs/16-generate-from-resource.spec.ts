import { test, expect } from '../fixtures/auth';

/**
 * Smoke test — GENERATE-FROM-BUTTON.md Phase 5 (the REQUIRED e2e coverage):
 * the resource-generate flow this plan adds, end-to-end through the real bus.
 *
 * Flow (ResourceViewerPage → ResourceInfoPanel → ResourceGenerateModal):
 *   Resource Info panel → **Generate** button (above Clone)
 *     → modal opens on `configure-gather`
 *     → [P4] exclude an entity type from recall
 *     → Gather → real `gather:resource-requested`→`-complete` round-trip
 *     → `review` step renders the resource `GatheredContext` (kind-aware GatherContextStep)
 *     → Next → `configure-generation`
 *     → Generate → `yield.fromResource` runs the `generation` job → new derived resource.
 *
 * Covers the seams unit tests can't reach under the #900 native-binding skew:
 * the real bus request/reply gather, the cold-`StreamObservable.run()` job
 * lifecycle, and the button → modal → viewer wiring. The two LLM round-trips
 * (gather + generation) make this slow — hence the long timeout.
 *
 * Selectors are label-independent where it matters: the Info panel opens via the
 * Toolbar's `button[data-panel="info"]`; the exclusion chips are
 * `.semiont-form__entity-type-button`; step transitions are asserted on the bus
 * (i18n-independent). The few accessible-name selectors use the `ResourceGenerate`
 * / `ResourceInfoPanel` en.json labels (Generate, Gather, Next, Configure Gather,
 * Review Context, Configure Generation).
 *
 * Requires: the seeded KB has the default entity types (for the P4 exclusion).
 */
test.describe('generate from resource', () => {
  test('Generate button → gather round-trips → review → generation yields a derived resource', async ({ signedInPage: page, bus }) => {
    test.setTimeout(180_000);

    // Open the first resource.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // ── Resource Info panel: the terse `Generate` button renders ABOVE Clone ──
    await page.locator('button[data-panel="info"]').click();
    const infoPanel = page.locator('.semiont-resource-info-panel');
    await expect(infoPanel).toBeVisible({ timeout: 10_000 });
    const generateBtn = infoPanel.getByRole('button', { name: /generate/i });
    const cloneBtn = infoPanel.getByRole('button', { name: /clone/i });
    await expect(generateBtn).toBeVisible();
    await expect(cloneBtn).toBeVisible();
    const genBox = await generateBtn.boundingBox();
    const cloneBox = await cloneBtn.boundingBox();
    if (!genBox || !cloneBox) throw new Error('Generate/Clone button has no bounding box');
    expect(genBox.y, 'Generate renders above Clone').toBeLessThan(cloneBox.y);

    // ── Click Generate → modal opens on the configure-gather step ──
    await generateBtn.click();
    // Scope to the visible panel, not the headlessui Dialog wrapper: the
    // role="dialog" element is a zero-box positioning wrapper Playwright treats
    // as "hidden". `--gather` is unique to this modal (excludes the info-panel
    // Generate button still in the background DOM).
    const modal = page.locator('.semiont-search-modal__panel--gather');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal).toContainText('Configure Gather');

    // ── [P4] Exclude an entity type from recall (threaded as excludeEntityTypes) ──
    const excludeChips = modal.locator('.semiont-form__entity-type-button');
    await expect(excludeChips.first()).toBeVisible({ timeout: 10_000 });
    const firstChip = excludeChips.first();
    await firstChip.click();
    await expect(firstChip).toHaveAttribute('data-selected', 'true');
    // (The selected type rides into the `gather` call as excludeEntityTypes; the
    //  recall-omission effect is LLM-output-dependent, so we assert the threading
    //  via the UI selection + the gather round-trip below, not the recall contents.)

    bus.clear();

    // ── Gather → real gather.resource round-trips, review step renders the context ──
    await modal.getByRole('button', { name: /gather/i }).click();
    await bus.expectRequestResponse('gather:resource-requested', 'gather:resource-complete', 60_000);

    // review step: title flips + Next enables only once the GatheredContext is in
    // (the modal disables Next while `!context`), so an enabled Next == the
    // kind-aware GatherContextStep rendered the resource context.
    await expect(modal).toContainText('Review Context');
    const nextBtn = modal.getByRole('button', { name: /^next/i });
    await expect(nextBtn).toBeEnabled({ timeout: 30_000 });

    // ── Advance to configure-generation ──
    await nextBtn.click();
    await expect(modal).toContainText('Configure Generation');

    // ConfigureGenerationStep is an HTML `<form>` with two `required` fields —
    // `#wizard-title` (pre-filled) and `#wizard-storagePath` (EMPTY by default).
    // The Generate button is `type="submit"`, so leaving storagePath empty makes
    // the browser block submission (no `onGenerate`, no job) — exactly as spec 09
    // documents. Fill both (unique per-run title so successive runs don't pile up
    // same-named derived resources at the top of Discover).
    const runId = Date.now();
    const titleInput = modal.locator('#wizard-title');
    await expect(titleInput).toBeAttached({ timeout: 5_000 });
    await titleInput.fill(`e2e-spec-16-${runId}`);
    await modal.locator('#wizard-storagePath').fill(`generated/e2e-16-${runId}.md`);

    bus.clear();

    // ── Generate → yield.fromResource runs the `generation` job → derived resource ──
    // Same job lifecycle as spec 09 (shared runGeneration driver): job:create
    // (jobType generation) → job:created → job:complete (carrying the new
    // result.resourceId; the worker also mints the source→derived provenance ref).
    await modal.getByRole('button', { name: /generate/i }).last().click();

    const { request: createReq } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);
    expect(createReq.cid, 'generation job:create must carry a correlationId').toBeTruthy();

    const outcome = await Promise.race([
      bus.waitForRecv('job:complete', { timeout: 120_000 }).then((e) => ({ kind: 'complete' as const, entry: e })),
      bus.waitForRecv('job:fail', { timeout: 120_000 }).then((e) => ({ kind: 'fail' as const, entry: e })),
    ]);
    expect(outcome.kind, 'generation produced job:complete (a new derived resource), not job:fail').toBe('complete');
  });
});
