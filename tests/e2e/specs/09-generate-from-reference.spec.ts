import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: the generate-from-unresolved-reference flow runs end-to-end
 * through the worker pool and produces a `job:complete` (not `job:fail`)
 * with the new resource id.
 *
 * The production chain is:
 *
 *   Annotate mode → References panel
 *     → click ❓ on an unresolved reference
 *     → ReferenceEntry: `client.bind.initiate({...})`
 *     → bus `bind:initiate`
 *     → resource-viewer page VM opens the wizard
 *     → user clicks "Generate" (gather step)
 *     → wizard transitions to `configure-generation`
 *     → user submits
 *     → ResourceViewerPage `handleWizardGenerateSubmit`
 *     → `client.yield.fromAnnotation(resourceId, annotationId, options)`
 *     → bus `job:create` (with jobType="generation")
 *     → bus `job:created` (jobId)
 *     → worker claims job, calls inference, uploads result via
 *       `client.yield.resource(...)` (multipart POST /resources)
 *     → bus `job:complete` (with `result.resourceId`)
 *
 * Why we wait for completion (not just dispatch):
 *
 * Spec 06 stops at `job:create` / `job:created` because reference
 * detection is dispatch-shaped (the LLM round-trip happens out of
 * band). For *generation*, the load-bearing failure modes are
 * downstream of dispatch — at upload time, when the worker calls
 * `client.yield.resource(...)`. A dispatch-only assertion misses the
 * regression class where dispatch succeeds but the worker's upload
 * path is broken (e.g. an XHR-only branch in HttpContentTransport
 * that crashes in Node with "XMLHttpRequest is not defined"). We
 * wait for `job:complete` (or `job:fail`, which fails the test with
 * the actual error message).
 *
 * Cost: this test is slow because it waits for a real LLM round-trip
 * plus an upload. Budget: 90s for the generation, 120s for the whole
 * test. If the seeded KB's inference provider (gemma4:26b on Ollama
 * by default) is unreachable or slow, this test will time out — but
 * that's a real environmental break, not a flake.
 *
 * Requires the seeded KB to have:
 *   - At least one resource with at least one *unresolved* reference
 *     annotation (motivation `linking`, body lacking a SpecificResource).
 *     The default seed has these on the Leland Stanford / Charles Crocker
 *     fixtures.
 *   - A working inference provider configured for the `generation`
 *     job type.
 */
test.describe('generate from unresolved reference', () => {
  test('clicking generate on an unresolved reference produces a job:complete with a new resourceId', async ({ signedInPage: page, bus }) => {
    test.setTimeout(120_000);

    // ── Find a resource that still has at least one unresolved reference ──
    //
    // The test's own success bound the unresolved reference it
    // generated against, so successive runs (or a previous run that
    // already consumed the first card's ❓ pool) need to find a
    // *different* card with remaining unresolved references. A
    // generated resource also tends to land first on Discover (newest
    // first), so the prior `firstCard` heuristic was data-coupled.
    // Iterate through up to 8 cards and pick the first one whose
    // References panel surfaces a ❓.

    await page.goto('/en/know/discover');
    const cards = page.getByRole('button', { name: /^open resource:/i });
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    const cardCount = Math.min(8, await cards.count());
    expect(cardCount, 'Discover must list at least one resource').toBeGreaterThan(0);

    let unresolvedFound = false;
    for (let i = 0; i < cardCount; i++) {
      await cards.nth(i).click();
      await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

      // Enter annotate mode.
      await page.getByRole('button', { name: /^mode$/i }).click();
      await page.getByRole('menuitem', { name: /^annotate$/i }).click();
      await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 15_000 });

      // Switch right sidebar to Annotations → References.
      // The shell VM persists the active panel across navigations, so
      // the Annotations button may already be pressed from a previous
      // iteration. Toggling it unconditionally would close the panel
      // and hide the 🔵 References tab. Only click if not pressed.
      const annotationsBtn = page.getByRole('button', { name: /^annotations$/i });
      if ((await annotationsBtn.getAttribute('aria-pressed')) !== 'true') {
        await annotationsBtn.click();
      }
      const referencesTab = page.getByRole('button', { name: '🔵', exact: true });
      await expect(referencesTab).toBeVisible({ timeout: 10_000 });
      if ((await referencesTab.getAttribute('aria-pressed')) !== 'true') {
        await referencesTab.click();
      }

      // Resolved references render 🔗 (clickable to open the target);
      // unresolved render ❓ (clickable in annotate mode to open the
      // wizard).
      const candidate = page.getByRole('main')
        .locator('button.semiont-reference-icon')
        .filter({ hasText: '❓' })
        .first();

      try {
        await expect(candidate).toBeVisible({ timeout: 5_000 });
        unresolvedFound = true;
        bus.clear();
        await candidate.click();
        break;
      } catch {
        // No ❓ in this card's references panel. Back to Discover and try the next.
        await page.goto('/en/know/discover');
        await expect(cards.first()).toBeVisible({ timeout: 10_000 });
      }
    }

    expect(unresolvedFound, `seeded KB must have ≥1 resource with an unresolved reference (checked ${cardCount} cards)`).toBe(true);

    // ── Wizard opens at the gather step; click Generate ────────────────
    //
    // HeadlessUI's `Dialog` wrapper renders with `data-headlessui-state`
    // toggling between `closed`/`open`, but Playwright's `getByRole('dialog')`
    // visibility check trips on the transition state. Scope to the
    // wizard's panel class (`semiont-search-modal__panel`) which only
    // mounts when the dialog content is fully rendered.
    const wizard = page.locator('.semiont-search-modal__panel');
    await expect(wizard).toBeAttached({ timeout: 10_000 });

    // The gather step renders three options: "🔍 Search…", "✨ Generate…",
    // "✍️ Compose". Match by substring — the emoji prefix and ellipsis
    // suffix vary per locale.
    await wizard.getByRole('button', { name: /generate/i }).click();

    // ── Configure-generation step: fill required fields, submit ────────
    //
    // The configure step has two HTML5-required fields:
    //   - `wizard-title` (pre-filled from the selected text — but we
    //     overwrite with a unique per-run value so successive test
    //     runs don't accumulate same-named generated resources at the
    //     top of Discover, which collides with spec 03's
    //     "first-two-cards-have-distinct-names" assertion)
    //   - `wizard-storagePath` (empty by default — we MUST fill this
    //     or the form won't submit)
    // Plus optional prompt / language / temperature / maxTokens.

    const runId = Date.now();
    const titleInput = wizard.locator('#wizard-title');
    await expect(titleInput).toBeAttached({ timeout: 5_000 });
    await titleInput.fill(`e2e-spec-09-${runId}`);

    const storagePathInput = wizard.locator('#wizard-storagePath');
    await storagePathInput.fill(`generated/e2e-${runId}.md`);

    // Submit. The button label is "✨ Generate" on this step.
    await wizard.getByRole('button', { name: /generate/i }).last().click();

    // ── Protocol assertions ─────────────────────────────────────────────
    //
    // Dispatch: `job:create` was emitted and the backend acked.
    const { request: createReq } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);
    expect(createReq.cid, 'job:create must carry a correlationId').toBeTruthy();

    // Completion: `job:complete` (not `job:fail`) arrives within the
    // generation timeout. We race the two so a failure surfaces with
    // the actual error message rather than as a generic "timeout
    // waiting for job:complete".
    const completeOrFail = await Promise.race([
      bus.waitForRecv('job:complete', { timeout: 90_000 }).then((e) => ({ kind: 'complete' as const, entry: e })),
      bus.waitForRecv('job:fail', { timeout: 90_000 }).then((e) => ({ kind: 'fail' as const, entry: e })),
    ]);

    if (completeOrFail.kind === 'fail') {
      // The bus-log capture only records a prefix of the payload, so the
      // detailed error is in the raw text. Surface it for diagnostic
      // value — combined with the jaeger-window-traces.json attachment
      // (auto-generated by the jaeger fixture), this gives the developer
      // both the wire-level and span-level view of the failure.
      throw new Error(
        `Expected job:complete, got job:fail. Recent bus entries:\n` +
        bus.entries.slice(-15).map((e) => `  [${e.op}] ${e.channel} ${e.raw}`).join('\n'),
      );
    }

    // ── Sanity: the auto-bind side-effect arrives ──────────────────────
    //
    // The generation flow auto-binds the unresolved reference to the
    // newly-created resource via Stower's `yield:create` handler when
    // `generatedFrom.annotationId` is present. The visible signal of
    // success (beyond the bare `job:complete`) is a `mark:body-updated`
    // domain event that flips the reference from ❓ to 🔗.
    //
    // `mark:body-updated` is a broadcast domain event, not a
    // request/response — it does NOT carry a correlationId. Asserting
    // its arrival is the right shape; asserting on `.cid` would fail
    // by construction.
    //
    // Soft assertion: `job:complete` above is the ground truth. If the
    // body-update is delayed past the timeout, don't fail the test —
    // surface a console warning instead so a Stower-side projection
    // bug shows up in test logs without flaking the regression target.
    const bodyUpdated = await bus.waitForRecv('mark:body-updated', { timeout: 10_000 }).catch(() => null);
    if (!bodyUpdated) {
      // eslint-disable-next-line no-console
      console.warn('[spec 09] job:complete arrived but mark:body-updated did not — possible Stower projection bug');
    }
  });
});
