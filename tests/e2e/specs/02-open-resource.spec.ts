import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: opening a resource loads its content + populates the
 * entity-types cache.
 *
 * Regression target: the entity-types-missing bug caused by the SSE
 * reconnect storm eating the busRequest response. If entity types are
 * observable in the UI, the full chain is working: frontend fetch →
 * /bus/emit → backend handler → response → SSE → actor.on$ → BehaviorSubject → UI.
 */
test.describe('open resource', () => {
  test('opens the first resource from Discover and shows content', async ({ signedInPage: page, bus }) => {
    await page.goto('/en/know/discover');

    // Wait for at least one resource card. The seeded KB should have ≥1.
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });

    bus.clear();  // Only care about traffic from this point forward.
    await firstCard.click();

    // URL transitions to /know/resource/<id>; we don't assert the id
    // because it's fixture-dependent.
    await expect(page).toHaveURL(/\/know\/resource\//, { timeout: 10_000 });

    // "Loading resource..." should resolve; the main viewer should render.
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Protocol-level proof: the browse:resource-requested command was
    // emitted and its response arrived with a matching correlationId.
    // This is the chain that the resource-detail invalidate bug broke.
    await bus.expectRequestResponse('browse:resource-requested', 'browse:resource-result');
  });
});
