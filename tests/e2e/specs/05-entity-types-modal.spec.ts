import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: the "Detect Entity References" modal populates with
 * entity types from the backend.
 *
 * Regression target: the entity-types-never-arrive bug. Same data as
 * test 02 but via a different UI surface (modal, driven by
 * `semiont!.browse.entityTypes()` direct rather than through the
 * resource page VM).
 *
 * Requires the seeded KB to have ≥1 entity type defined.
 */
test.describe('entity types modal', () => {
  // TODO: `ProposeEntitiesModal` is exported from @semiont/react-ui but
  // not yet mounted anywhere in the frontend app — there's no path to
  // open it from the running UI, so this test has no target.
  //
  // The entity-types data path it was meant to exercise IS covered:
  //   - Test 02 passes only if `vm.entityTypes$` populates (the
  //     resource page VM maps it into `allEntityTypes`).
  //   - Backend delivery was verified by hand this session.
  //
  // Restore this test when ProposeEntitiesModal is wired into the UI
  // (or retarget it at the References panel's entity-type chip picker,
  // which has the same cache behind it).
  test.skip('Detect Entity References modal shows entity types', async ({ signedInPage: page }) => {
    // Open a resource so the References panel is reachable.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });

    // Open the References panel if it isn't already open. Scope to the
    // main region so we don't match the footer's "Cookie Preferences"
    // button, which also has "references" as a substring pattern.
    const main = page.getByRole('main');
    const refsToggle = main.getByRole('button', { name: /^references$/i }).first();
    if (await refsToggle.isVisible().catch(() => false)) {
      await refsToggle.click();
    }

    // Click "Detect Entity References". The button text starts with
    // "✨ Detect Entity References" per the modal source.
    const detectButton = page.getByRole('button', { name: /detect entity references/i }).first();
    await expect(detectButton).toBeVisible({ timeout: 10_000 });
    await detectButton.click();

    // The ProposeEntitiesModal opens. Confirm entity type chips are
    // rendered (class `semiont-chip`). At least one must appear; empty
    // state would show "No entity types available" instead.
    const chips = page.locator('.semiont-chip');
    await expect.poll(async () => chips.count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // Absence of the empty-state text is also required.
    await expect(page.getByText(/no entity types available/i)).toBeHidden();
  });
});
