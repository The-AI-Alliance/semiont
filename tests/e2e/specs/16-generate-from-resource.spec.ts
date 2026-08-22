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
 *     → Generate → `yield.fromContext` (resource focus) runs the `generation` job → new derived resource.
 *
 * Covers the seams unit tests can't reach under the #900 native-binding skew:
 * the real bus request/reply gather, the cold-`StreamObservable.run()` job
 * lifecycle, and the button → modal → viewer wiring. The two LLM round-trips
 * (gather + generation) make this slow — hence the long timeout.
 *
 * Selectors are label-independent where it matters: the Info panel opens via the
 * Toolbar's `button[data-panel="info"]`; the exclusion chips are
 * `.semiont-form__entity-type-button`; progress is asserted on the bus
 * (i18n-independent). The few accessible-name selectors use the `ResourceGenerate`
 * / `ResourceInfoPanel` en.json labels — now only **Generate** and **Gather**.
 *
 * The flow is ONE composite stack as of GATHER-AT-THE-TOP (#1211): gather
 * controls (top) → evidence → generation params (bottom). There is no review
 * step, no Next, and no per-step titles, so progress is asserted structurally.
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
    // The AssistShell adds a collapsible "Generate ›" section header, so match
    // the ✨ prefix — literal in ResourceInfoPanel, unlike the translated word.
    const generateBtn = infoPanel.getByRole('button', { name: /✨.*generate/i });
    const cloneBtn = infoPanel.getByRole('button', { name: /clone/i });
    await expect(generateBtn).toBeVisible();
    await expect(cloneBtn).toBeVisible();
    const genBox = await generateBtn.boundingBox();
    const cloneBox = await cloneBtn.boundingBox();
    if (!genBox || !cloneBox) throw new Error('Generate/Clone button has no bounding box');
    expect(genBox.y, 'Generate renders above Clone').toBeLessThan(cloneBox.y);

    // ── Click Generate → the modal opens as ONE composite stack ──
    await generateBtn.click();
    // Scope to the visible panel, not the headlessui Dialog wrapper: the
    // role="dialog" element is a zero-box positioning wrapper Playwright treats
    // as "hidden". `--gather` is unique to this modal (excludes the info-panel
    // Generate button still in the background DOM).
    const modal = page.locator('.semiont-search-modal__panel--gather');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.locator('.semiont-wizard__step-scroll')).toBeVisible();

    // ── [P4] Exclude an entity type from recall (threaded as excludeEntityTypes) ──
    // Inverted UI: every type is IN recall until crossed off, so clicking
    // EXCLUDES it — data-included flips true → false.
    const recallChips = modal.locator('.semiont-form__recall-chip');
    await expect(recallChips.first()).toBeVisible({ timeout: 10_000 });
    const firstChip = recallChips.first();
    await expect(firstChip).toHaveAttribute('data-included', 'true');
    await firstChip.click();
    await expect(firstChip, 'clicking a recall chip EXCLUDES that type').toHaveAttribute('data-included', 'false');
    // (The selected type rides into the `gather` call as excludeEntityTypes; the
    //  recall-omission effect is LLM-output-dependent, so we assert the threading
    //  via the UI selection + the gather round-trip below, not the recall contents.)

    bus.clear();

    // ── Gather → real gather.resource round-trips, evidence unfolds in place ──
    await modal.getByRole('button', { name: /gather/i }).click();
    await bus.expectRequestResponse('gather:resource-requested', 'gather:resource-complete', 60_000);

    // The spent controls fold into a receipt, gated on `gatherFired`.
    const receipt = modal.locator('.semiont-gather-receipt');
    await expect(receipt).toBeVisible({ timeout: 30_000 });

    // ConfigureGenerationStep mounts only under `gatherFired && gatherContext`,
    // so the params appearing means the GatheredContext arrived.
    const titleInput = modal.locator('#wizard-title');
    await expect(titleInput).toBeAttached({ timeout: 30_000 });

    // The fold: gather at the top, generation params at the bottom.
    const receiptBox = await receipt.boundingBox();
    const paramsBox = await titleInput.boundingBox();
    if (!receiptBox || !paramsBox) throw new Error('receipt/params has no bounding box');
    expect(receiptBox.y, 'gather receipt sits above the generation params').toBeLessThan(paramsBox.y);

    // No Back in a single stack (D6).
    await expect(modal.getByRole('button', { name: /^back$/i })).toHaveCount(0);

    // ConfigureGenerationStep is an HTML `<form>` with two `required` fields —
    // `#wizard-title` (pre-filled) and `#wizard-storagePath` (EMPTY by default).
    // The Generate button is `type="submit"`, so leaving storagePath empty makes
    // the browser block submission (no `onGenerate`, no job) — exactly as spec 09
    // documents. Fill both (unique per-run title so successive runs don't pile up
    // same-named derived resources at the top of Discover).
    const runId = Date.now();
    await titleInput.fill(`e2e-spec-16-${runId}`);
    await modal.locator('#wizard-storagePath').fill(`generated/e2e-16-${runId}.md`);

    bus.clear();

    // ── Generate → yield.fromContext runs the `generation` job → derived resource ──
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
