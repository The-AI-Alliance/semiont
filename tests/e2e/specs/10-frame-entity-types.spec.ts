import { test, expect } from '../fixtures/auth';

/**
 * Smoke test: the Frame flow's entity-type vocabulary surface end-to-end.
 *
 * Two things are exercised:
 *
 * 1. **Server bootstrap.** On startup the backend's `bootstrapEntityTypes`
 *    seeds the KB with `DEFAULT_ENTITY_TYPES` from `@semiont/ontology` by
 *    emitting `frame:add-entity-type` for each type missing from the
 *    `__system__` event log. After that runs, `browse.entityTypes()`
 *    must return all defaults. We assert the moderate-entity-tags page
 *    renders the 9 default chips on load.
 *
 * 2. **Live add round-trip.** Typing a new tag and clicking Add invokes
 *    `client.frame.addEntityType(...)` which emits `frame:add-entity-type`
 *    over the wire. The backend's Stower handles it and broadcasts
 *    `frame:entity-type-added` (a bridged channel — see
 *    `packages/core/src/bridged-channels.ts`); the frontend's
 *    `browse.entityTypes()` cache invalidates on receipt and the new
 *    tag renders without a refresh.
 *
 * Regression targets:
 *
 * - Bootstrap regression: a default type missing from the rendered
 *   chip list, or none at all → bootstrap didn't fire / didn't reach
 *   the materialized view.
 * - Bridge regression: the new tag never renders → `frame:entity-type-added`
 *   isn't reaching the frontend (would mirror the `yield:create-ok`
 *   bridging gap fixed earlier).
 * - SDK regression: `[bus EMIT] frame:add-entity-type` never fires →
 *   the moderate page's `addTag()` chain isn't reaching the namespace
 *   method.
 *
 * The added tag carries a per-test timestamp suffix so reruns don't
 * collide. The test does not clean up after itself — entity types are
 * additive and harmless to leave behind in a long-running KB.
 */
test.describe('frame entity-type vocabulary', () => {
  test('bootstrap-seeded defaults render, and a new tag round-trips through frame:* and refreshes the list', async ({
    signedInPage: page,
    bus,
  }) => {
    await page.goto('/en/moderate/entity-tags');

    // ── Bootstrap assertion ─────────────────────────────────────────────
    //
    // The 9 defaults shipped by `@semiont/ontology`'s DEFAULT_ENTITY_TYPES.
    // If the bootstrap hadn't fired, none of these would render.
    const DEFAULT_ENTITY_TYPES = [
      'Person', 'Organization', 'Location', 'Event', 'Concept',
      'Product', 'Technology', 'Date', 'Author',
    ];
    const tagList = page.locator('.semiont-tags');
    await expect(tagList).toBeVisible({ timeout: 15_000 });

    for (const type of DEFAULT_ENTITY_TYPES) {
      // Each tag renders as a `.semiont-tag` span containing the literal
      // text. Use a strict text match scoped to the tag list so we don't
      // false-positive on the input placeholder or elsewhere.
      await expect(
        tagList.locator('.semiont-tag', { hasText: new RegExp(`^${type}$`) }),
      ).toBeVisible({ timeout: 10_000 });
    }

    // ── Live add round-trip ────────────────────────────────────────────
    //
    // Use a per-run-unique tag so reruns against the same KB don't
    // collide. The bus capture lets us assert the protocol-level path,
    // independent of the UI's subsequent re-render.
    const newTag = `E2E-${Date.now()}`;

    bus.clear();

    const input = page.getByPlaceholder(/^.+$/).first();
    // The page's input is the only top-level text input in the tags
    // section. Lock to a more specific selector to avoid grabbing
    // toolbar inputs when the layout grows.
    const tagInput = page.locator('.semiont-entity-tags__input');
    await expect(tagInput).toBeVisible();
    await tagInput.fill(newTag);

    // The page exposes both an Add button and Enter-key submit. Submit
    // via the button so we exercise the same path the moderation user
    // takes.
    const addButton = page.getByRole('button', { name: /add tag/i });
    await expect(addButton).toBeEnabled();
    await addButton.click();

    // Acknowledge `input` was assigned but not used — keep it as
    // documentation of the alternative selector if the page changes.
    void input;

    // Protocol assertion: the wire saw both the command and the
    // broadcast acknowledgment. `frame:add-entity-type` is the
    // command emitted by the SDK; `frame:entity-type-added` is the
    // bridged broadcast that drives cache invalidation.
    await bus.waitForEmit('frame:add-entity-type', { timeout: 10_000 });
    await bus.waitForRecv('frame:entity-type-added', { timeout: 10_000 });

    // UI assertion: the new tag renders without a refresh — the
    // browse-namespace's `entityTypes()` cache picked up the
    // `frame:entity-type-added` broadcast and re-emitted with the new
    // value. If this fails but the bus assertions passed, the bridge
    // is fine but the cache invalidation handler is broken.
    await expect(
      tagList.locator('.semiont-tag', { hasText: new RegExp(`^${newTag}$`) }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
