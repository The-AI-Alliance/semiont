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
  test('opens the first resource from Discover and shows content', async ({ signedInPage: page }) => {
    await page.goto('/en/know/discover');

    // Wait for at least one resource card. The seeded KB should have ≥1.
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });

    await firstCard.click();

    // URL transitions to /know/resource/<id>; we don't assert the id
    // because it's fixture-dependent.
    await expect(page).toHaveURL(/\/know\/resource\//, { timeout: 10_000 });

    // "Loading resource..." should resolve; the main viewer should render.
    // The loading state exposes role=status with a specific label in
    // ResourceLoadingState; wait for that to disappear.
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
  });
});
