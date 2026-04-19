import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: navigating to a second resource from within the app
 * actually updates the viewer (not just the URL).
 *
 * Regression target: the useViewModel-captures-initial-rId bug.
 * Fixed by splitting KnowledgeResourcePage into outer-reads-params +
 * inner-keyed-on-rId; without that, the component stayed mounted
 * across :id changes and the VM never rebuilt.
 *
 * Strategy: open resource A, go back to Discover via the sidebar
 * (client-side nav, keeps the knowledge layout mounted), then click
 * resource B. If the second navigation still lands in the same
 * ResourceViewerPage component instance (which is the condition the
 * bug needs), the key-based remount must refresh the VM.
 *
 * Requires the seeded KB to have at least two resources.
 */
test.describe('navigate between resources', () => {
  test('opening a second resource updates content (not just URL)', async ({ signedInPage: page, bus }) => {
    await page.goto('/en/know/discover');

    const cards = page.getByRole('button', { name: /^open resource:/i });
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    const firstName = ((await cards.nth(0).getAttribute('aria-label')) ?? '')
      .replace(/^open resource:\s*/i, '').trim();
    const secondName = ((await cards.nth(1).getAttribute('aria-label')) ?? '')
      .replace(/^open resource:\s*/i, '').trim();
    expect(firstName).not.toBe(secondName);

    // Open first resource.
    bus.clear();
    await cards.nth(0).click();
    await expect(page).toHaveURL(/\/know\/resource\//);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
    const firstUrl = page.url();

    // The first resource's name should appear on the page (typically
    // in a header or the sidebar tab). This is our content marker.
    await expect(page.getByText(firstName).first()).toBeVisible({ timeout: 10_000 });

    // Protocol proof: first resource fetch round-tripped. Capture its
    // cid, then clear the bus log — `expectRequestResponse` searches
    // from the start of the accumulated log, so without a clear the
    // second invocation below would find the same pair again.
    const firstCid = (await bus.expectRequestResponse(
      'browse:resource-requested',
      'browse:resource-result',
    )).request.cid;
    bus.clear();

    // Client-side-navigate back to Discover via the sidebar link. Using
    // the link (not page.goto) preserves the knowledge layout mount and
    // matches what a real user does.
    await page.getByRole('link', { name: /discover/i }).first().click();
    await expect(page).toHaveURL(/\/know\/discover/);

    // Click the second resource card. This is a client-side navigation
    // from Discover into the resource viewer — the exact transition
    // where the useViewModel-stale-factory bug would manifest, if the
    // component were reused (which would be the case if the user
    // navigated via a resource-tab click while already viewing another
    // resource).
    await cards.nth(1).click();
    await expect(page).toHaveURL(/\/know\/resource\//);
    await expect(page.url()).not.toBe(firstUrl);
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Content must reflect the SECOND resource, not the first.
    await expect(page.getByText(secondName).first()).toBeVisible({ timeout: 10_000 });

    // Protocol proof: a *second* browse:resource-requested fired with a
    // fresh correlationId, and its matching response arrived. This is
    // the concrete regression signal for the useViewModel-stale-factory
    // bug — if the VM stayed bound to rId A, there'd be no second emit
    // at all.
    const secondCid = (await bus.expectRequestResponse(
      'browse:resource-requested',
      'browse:resource-result',
    )).request.cid;
    expect(secondCid).not.toBe(firstCid);

    // Sanity: combining the saved first cid with everything emitted
    // post-clear, we saw at least two distinct resource fetches.
    const postClearCids = new Set(bus.emits('browse:resource-requested').map(e => e.cid));
    postClearCids.add(firstCid);
    expect(postClearCids.size).toBeGreaterThanOrEqual(2);
  });
});
