import { test, expect } from '../fixtures/auth';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';
import { SemiontClient, type TagSchema } from '@semiont/sdk';

/**
 * Regression guard — `frame:tag-schema-added` must reach a resource-subscribed
 * page EXACTLY ONCE (the `BRIDGED ∩ RESOURCE_SCOPED` double-delivery bug).
 * See `.plans/bugs/BRIDGE-GAPS.md` → "To automate this (Playwright e2e)".
 *
 * The bug: `frame:tag-schema-added` was in **both** `BRIDGED_CHANNELS` (the
 * global fan-in every client subscribes to) **and** `RESOURCE_SCOPED_CHANNELS`
 * (the per-resource subscription opened by `subscribeToResource`). A page with
 * a resource open therefore subscribed to it twice on one SSE connection —
 * once via `?channel=` (global, `scope=undefined`, ephemeral id) and once via
 * `?scoped=` (`scope=<rId>`, persisted id). Two different SSE ids defeated the
 * client's `seenEventIds` dedup, so **both** copies were delivered onto the
 * client bus. Fix #2 removed every bridged channel from
 * `RESOURCE_SCOPED_CHANNELS`, leaving the single global delivery.
 *
 * Why this is the *deterministic* half of the BRIDGE-GAPS repro: unlike the
 * reconnect-overlap bug (Fix #1), this double-delivery needs no make-before-
 * break race — it happens on any steady-state resource-subscribed connection.
 * (The reconnect-overlap half stays guarded at the unit level: the
 * `e-<channel>:<cid>` deterministic-id test in `apps/backend/.../bus.test.ts`.)
 *
 * Signal: `[bus RECV]` is logged at `actor-state-unit.ts` only for events that
 * pass the `seenEventIds` dedup, so `bus.receives(channel).length` is the
 * post-dedup client-bus delivery count — **2 before the fix, 1 after**.
 *
 * Mechanics:
 *  - The PAGE holds the resource-subscribed connection (the one that
 *    double-delivered); its console bus-log is what the `bus` fixture captures.
 *  - A parallel SDK client (same backend/user, like spec 11) only *triggers*
 *    one `frame:tag-schema-added`; the event fans out to the page over SSE.
 *  - A stable schema id is fine: the Stower appends a domain event on every
 *    `addTagSchema` (re-registration is a projection no-op but still emits),
 *    so the broadcast fires each run.
 */

const DEDUP_SCHEMA: TagSchema = {
  id: 'e2e-dedup-schema',
  name: 'E2E Dedup Schema',
  description:
    'Registered by the e2e suite solely to emit one frame:tag-schema-added and assert it is delivered to a resource-subscribed page exactly once.',
  domain: 'test',
  tags: [
    {
      name: 'Marker',
      description: 'A placeholder category; this schema is never applied, only registered.',
      examples: ['n/a'],
    },
  ],
};

test.describe('frame:tag-schema-added single delivery (BRIDGED ∩ RESOURCE_SCOPED)', () => {
  test('a resource-subscribed page receives the bridged broadcast exactly once', async ({
    signedInPage: page,
    bus,
  }) => {
    test.setTimeout(60_000);

    // ── Open a resource → activate the resource-scoped SSE subscription ──
    // `subscribeToResource` (driven by the resource view's scoped browse
    // query) is what adds RESOURCE_SCOPED_CHANNELS to this connection — the
    // pre-fix source of the second, scoped delivery.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
    // Let the make-before-break scope reconnect fully settle, so the scoped
    // subscription is live AND the old (global-only) connection is gone before
    // we trigger the event. This keeps us out of the racy reconnect-overlap
    // path (Fix #1) and isolates the deterministic global+scoped overlap (Fix #2).
    await page.waitForTimeout(2_000);

    // ── Trigger exactly one frame:tag-schema-added from a parallel client ──
    const client = await SemiontClient.signInHttp({
      baseUrl: BACKEND_URL,
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });
    try {
      bus.clear();
      await client.frame.addTagSchema(DEDUP_SCHEMA);

      // The bridged broadcast must reach the page (≥1). If this times out,
      // `frame:tag-schema-added` isn't bridged at all (a different regression).
      await bus.waitForRecv('frame:tag-schema-added', { timeout: 10_000 });

      // A duplicate (the bug) arrives on the same connection immediately after
      // the first copy; wait long enough that it would have landed and been
      // ingested before we count.
      await page.waitForTimeout(2_000);

      const deliveries = bus.receives('frame:tag-schema-added');
      expect(
        deliveries.length,
        `frame:tag-schema-added must be delivered to a resource-subscribed page exactly once; ` +
          `${deliveries.length} means the BRIDGED ∩ RESOURCE_SCOPED overlap regressed ` +
          `(global + scoped dual-forward). delivery scopes=${JSON.stringify(deliveries.map((d) => d.scope))}`,
      ).toBe(1);
    } finally {
      client.dispose();
    }
  });
});
