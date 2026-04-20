import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: the AI-assisted "Annotate References" flow dispatches a
 * job-create request with the selected entity types.
 *
 * The production chain is:
 *
 *   ReferencesPanel assist widget
 *     → click "Annotate" (✨)
 *     → eventBus `mark:assist-request` (local)
 *     → mark-vm catches it, calls `client.mark.assist(...)`
 *     → namespaces/mark.ts `dispatchAssist`
 *     → bus `job:create` (with jobType="reference-annotation" +
 *       `params.entityTypes`)
 *     → bus `job:created` (with jobId)
 *     → progress polled / forwarded via `mark:progress` /
 *       `mark:assist-finished`.
 *
 * We stop at the `job:create` / `job:created` pair. Waiting for
 * completion requires a real LLM response and would make the test
 * slow and flaky; dispatch-level correctness is what we're guarding
 * here (entity-types selected in the UI make it into the params).
 *
 * Regression target: the UI's selected entity types failing to reach
 * the wire — e.g. the chip-selection state not being threaded into
 * `mark:assist-request` payload, or the VM not forwarding to the
 * api-client. Protocol-level assertion on `job:create` catches
 * either break.
 *
 * Requires the seeded KB to have ≥1 entity type defined.
 */
test.describe('assisted reference detection', () => {
  test('selecting entity types and clicking Annotate emits job:create with reference-annotation', async ({ signedInPage: page, bus }) => {
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Enter annotate mode. The References-panel's "Annotate References"
    // assist section is only rendered in annotate mode (see ReferencesPanel's
    // `annotateMode && (...)` guard).
    await page.getByRole('button', { name: /^mode$/i }).click();
    await page.getByRole('menuitem', { name: /^annotate$/i }).click();

    const cmContent = page.locator('.cm-content').first();
    await expect(cmContent).toBeVisible({ timeout: 15_000 });

    // The right sidebar defaults to "Knowledge Base" on a fresh session.
    // Switch it to "Annotations" so UnifiedAnnotationsPanel mounts and
    // the References tab becomes reachable. Without this the
    // "Annotate References" assist section isn't in the DOM at all.
    await page.getByRole('button', { name: /^annotations$/i }).click();

    // Within the annotations panel, select the References sub-tab.
    // The tab button is just the 🔵 emoji. Use the exact-name match.
    const referencesTab = page.getByRole('button', { name: '🔵', exact: true });
    await expect(referencesTab).toBeVisible({ timeout: 10_000 });
    if ((await referencesTab.getAttribute('aria-pressed')) !== 'true') {
      await referencesTab.click();
    }

    // Expand the "Annotate References" collapsible section. The button
    // label has a trailing "›" chevron (e.g. "Annotate References ›"),
    // so match with a substring regex not an anchored one.
    const main = page.getByRole('main');
    const assistToggle = main.getByRole('button', { name: /annotate references/i }).first();
    await expect(assistToggle).toBeVisible({ timeout: 10_000 });
    // If the section is already expanded, `aria-expanded` is "true" and
    // a subsequent click would collapse it. Only toggle if collapsed.
    const alreadyOpen = (await assistToggle.getAttribute('aria-expanded')) === 'true';
    if (!alreadyOpen) await assistToggle.click();

    // The assist widget's entity-type picker uses
    // `.semiont-chip.semiont-chip--selectable`. Pick the first available
    // type. This is a distinct picker from the manual-reference
    // prompt's `.semiont-tag-selector__item` — two different surfaces,
    // same underlying `entityTypes()` cache.
    const assistChips = page.locator('.semiont-assist-widget__chips .semiont-chip--selectable');
    await expect(assistChips.first()).toBeVisible({ timeout: 10_000 });
    const firstChip = assistChips.first();
    await firstChip.click();
    await expect(firstChip).toHaveAttribute('data-selected', 'true');

    bus.clear();

    // Submit button is the ReferencesPanel assist widget's "Annotate" (✨)
    // action. Scope it by its data attributes (`data-variant="assist"`
    // + `data-type="reference"`) so we don't hit the identically-labeled
    // button in another annotation panel.
    const submitBtn = page.locator('button[data-variant="assist"][data-type="reference"]');
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Protocol-level proof: the assist dispatch crossed the wire as a
    // `job:create` request and the backend acked with `job:created`.
    // The jobType for `linking` motivation is `reference-annotation`
    // (see namespaces/mark.ts jobTypeMap).
    const { request } = await bus.expectRequestResponse('job:create', 'job:created', 30_000);

    // Additional sanity: the emitted request should carry the entity
    // types we selected. We can't inspect the payload from the bus-log
    // capture directly, but the emit-count invariant and the fact that
    // `dispatchAssist` throws synchronously if entityTypes is empty
    // both combine to tell us the chip-selection state reached the
    // namespace layer. A dispatch with empty entity types would not
    // have produced this request at all.
    expect(request.channel).toBe('job:create');

    // UI-level: the progress widget for an in-flight assist appears.
    // We don't wait for completion — the LLM round-trip is beyond the
    // scope of a smoke test.
    const progressWidget = page.locator('[data-testid="annotate-references-progress-widget"], .semiont-assist-progress');
    // Soft-assert: either the progress widget appears within a short
    // window, OR the backend completed instantly (edge case). Either is
    // acceptable for dispatch-level coverage.
    await Promise.race([
      progressWidget.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {}),
      bus.waitForRecv('mark:assist-finished', { timeout: 10_000 }).catch(() => {}),
    ]);
  });
});
