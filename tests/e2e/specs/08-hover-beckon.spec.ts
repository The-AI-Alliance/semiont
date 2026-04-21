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
    // Open any resource that has annotations. Discover lists fixtures;
    // the first one should have enough to work with.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Stay in browse mode (default). BrowseView renders annotations as
    // `[data-annotation-id]` elements with hover handlers that call
    // `session.client.emit('beckon:hover', ...)` after a 150ms delay.
    // If there are no annotations on the fixture, this test is vacuous
    // — skip gracefully.
    const firstAnn = page.locator('[data-annotation-id]').first();
    const annCount = await firstAnn.count();
    test.skip(annCount === 0, 'fixture resource has no annotations to hover');

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
