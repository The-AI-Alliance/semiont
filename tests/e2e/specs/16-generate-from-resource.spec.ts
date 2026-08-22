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
 * REWRITTEN 2026-08-22 for GATHER-AT-THE-TOP (#1211), which folded the flow from
 * three step-pages into one composite stack:
 *
 *     was:  [Configure gather] --Gather--> [Review evidence] --Next--> [Params]
 *     now:  gather controls (top) → evidence → generation params (bottom)
 *
 * Four assertions died with it and are NOT to be reinstated: the three per-step
 * titles (D7 deleted those keys ×29 — the strings do not exist in the product),
 * and `Next` (D1 dissolved the review step, whose only action it was). They are
 * replaced by structural gates — `.semiont-gather-receipt` and the mount of
 * `#wizard-title` — which assert the same guarantees without naming copy.
 *
 * This spec was NOT updated when #1211 landed and went red on the next full run.
 * If the flow changes shape again, that is the failure to expect.
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
    // `/generate/i` alone is AMBIGUOUS as of GENERATE-FROM-RESOURCE P2, which
    // re-sited this control into an `AssistShell`. The shell adds a collapsible
    // SECTION HEADER — `<button aria-expanded>Generate ›</button>` — so the
    // regex matched two buttons and strict mode rejected the locator outright
    // (measured 2026-08-22; the control itself was fine).
    //
    // Discriminate on the ✨ prefix: it is literal in `ResourceInfoPanel`
    // (`✨ {t('generate')}`) while the word is translated, so it is the more
    // stable half of the name — and the section header has no emoji.
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
    // NO step-title assertion here. GATHER-AT-THE-TOP D7 collapsed the three
    // per-step titles into ONE modal title and deleted the orphan keys ×29, so
    // `Configure Gather` / `Review Context` / `Configure Generation` no longer
    // exist anywhere in the product. This spec asserted all three and went red
    // on the first (measured 2026-08-22). Structure is asserted below instead —
    // it survives copy changes, which is the whole reason those strings went.
    await expect(modal.locator('.semiont-wizard__step-scroll')).toBeVisible();

    // ── [P4] Exclude an entity type from recall (threaded as excludeEntityTypes) ──
    // #1211 renamed AND INVERTED this control. It was `.semiont-form__entity-type-button`
    // with `data-selected='true'` meaning "excluded"; it is now a recall chip where
    // every type is IN recall until crossed off, so the SAME act flips
    // `data-included` true → false. Porting the old assertion verbatim would have
    // asserted the opposite of the intent while still passing.
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

    // The spent controls fold into a receipt (D1: re-gathering is scroll-up →
    // tweak → Gather, not a step back). Its presence is gated on `gatherFired`,
    // so it is the structural proof that the gather actually ran — no copy.
    const receipt = modal.locator('.semiont-gather-receipt');
    await expect(receipt).toBeVisible({ timeout: 30_000 });

    // `ConfigureGenerationStep` mounts only under `gatherFired && gatherContext`,
    // so the params appearing IS "the GatheredContext arrived and the kind-aware
    // evidence rendered" — exactly the guarantee the deleted `Next`-enables-when-
    // `!context` assertion carried, re-expressed against the composite stack.
    const titleInput = modal.locator('#wizard-title');
    await expect(titleInput).toBeAttached({ timeout: 30_000 });

    // The fold itself: gather at the TOP, generation params at the BOTTOM of one
    // scroll pane. This is the structural claim GATHER-AT-THE-TOP makes, and the
    // one thing no copy assertion could ever have caught.
    const receiptBox = await receipt.boundingBox();
    const paramsBox = await titleInput.boundingBox();
    if (!receiptBox || !paramsBox) throw new Error('receipt/params has no bounding box');
    expect(receiptBox.y, 'gather receipt sits above the generation params').toBeLessThan(paramsBox.y);

    // NOTE: no Back button to assert — D6 removed it; in a single stack there is
    // nothing to go back to. If a Back reappears here, that is a regression of D6.
    await expect(modal.getByRole('button', { name: /^back$/i })).toHaveCount(0);

    // ConfigureGenerationStep is an HTML `<form>` with two `required` fields —
    // `#wizard-title` (pre-filled) and `#wizard-storagePath` (EMPTY by default).
    // The Generate button is `type="submit"`, so leaving storagePath empty makes
    // the browser block submission (no `onGenerate`, no job) — exactly as spec 09
    // documents. Fill both (unique per-run title so successive runs don't pile up
    // same-named derived resources at the top of Discover).
    // `titleInput` is already declared above — it doubles as the gate proving the
    // GatheredContext arrived (ConfigureGenerationStep mounts only under
    // `gatherFired && gatherContext`), so it is attached by the time we get here.
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
