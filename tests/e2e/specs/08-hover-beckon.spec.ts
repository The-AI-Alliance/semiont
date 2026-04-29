import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: hovering an annotation fires `beckon:hover` on the bus
 * and BeckonVM reacts by firing `beckon:sparkle`.
 *
 * Regression target (VMs-from-Session Stage D): `createBeckonVM` was
 * migrated from `(eventBus)` to `(client)` and internally rewired from
 * `eventBus.get('beckon:hover').subscribe(...)` to
 * `client.stream('beckon:hover').subscribe(...)` and from
 * `eventBus.get(...).next(...)` to `client.emit(...)`. If the factory's
 * internal bus wiring regressed, the hover would still fire `beckon:hover`
 * (because the component uses `session.client.emit` directly) but the
 * VM would never see it and the `beckon:sparkle` reaction would be
 * silent. Observing both events on the bus confirms the factory is
 * subscribing on the same bus the component is emitting to.
 */
test.describe('hover → beckon', () => {
  test('hovering an annotation fires beckon:hover and BeckonVM fires beckon:sparkle', async ({ signedInPage: page, bus }) => {
    // Find a resource that actually has annotations to hover. Successive
    // runs of spec 09 (generate-from-reference) push freshly-generated
    // (annotation-free) resources to the top of Discover, so the prior
    // `firstCard` heuristic was data-coupled. Iterate up to 8 cards and
    // pick the first one whose BrowseView surface has a
    // `[data-annotation-id]` element rendered.
    //
    // Scope the locator to `.semiont-browse-view` (BrowseView's container)
    // — `[data-annotation-id]` also appears in the references panel,
    // and only BrowseView's container has the mouseover handler bound
    // that fires `beckon:hover`.
    await page.goto('/en/know/discover');
    const cards = page.getByRole('button', { name: /^open resource:/i });
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    const cardCount = Math.min(8, await cards.count());

    let anyAnnotationFound = false;
    let firstAnn = page.locator('.semiont-browse-view [data-annotation-id]').first();
    for (let i = 0; i < cardCount; i++) {
      await cards.nth(i).click();
      await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

      // Stay in browse mode (default). BrowseView renders annotations as
      // `[data-annotation-id]` elements with hover handlers that call
      // `session.client.beckon.hover(...)` after a 150ms delay.
      const candidate = page.locator('.semiont-browse-view [data-annotation-id]').first();
      try {
        await expect(candidate).toBeVisible({ timeout: 3_000 });
        anyAnnotationFound = true;
        firstAnn = candidate;
        break;
      } catch {
        // No annotations in this resource's BrowseView. Back to Discover.
        await page.goto('/en/know/discover');
        await expect(cards.first()).toBeVisible({ timeout: 10_000 });
      }
    }

    expect(anyAnnotationFound, `seeded KB must have ≥1 resource with annotations in BrowseView (checked ${cardCount} cards)`).toBe(true);

    bus.clear();

    // Hover the annotation. Playwright's `hover()` fires the mouseenter
    // that kicks off the 150ms delay. Then we wait for the emission.
    await firstAnn.hover();

    // BeckonVM chain: `beckon:hover` emitted → VM subscribes via
    // `client.stream('beckon:hover')` → on non-null annotationId, emits
    // `beckon:sparkle`. Both should appear on the bus.
    await bus.waitForEmit('beckon:hover', { timeout: 5_000 });
    await bus.waitForEmit('beckon:sparkle', { timeout: 5_000 });
  });
});
