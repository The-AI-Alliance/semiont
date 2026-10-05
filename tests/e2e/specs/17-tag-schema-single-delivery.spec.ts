import { test, expect } from '../fixtures/auth';
import type { TagSchema } from '@semiont/sdk';
import { signInSession } from '../fixtures/sdk-session';

/**
 * `frame:tag-schema-added` must reach a resource-subscribed page EXACTLY ONCE:
 * no channel sits in `BRIDGED ∩ RESOURCE_SCOPED`.
 *
 * `BRIDGED_CHANNELS` is the global fan-in every client subscribes to, and
 * `RESOURCE_SCOPED_CHANNELS` the per-resource subscription opened by
 * `subscribeToResource`. A page with a resource open subscribes to a channel
 * in **both** twice on one SSE connection —
 * once via `?channel=` (global, `scope=undefined`, ephemeral id) and once via
 * `?scoped=` (`scope=<rId>`, persisted id). Two different SSE ids defeat the
 * client's `seenEventIds` dedup, so **both** copies are delivered onto the
 * client bus. With no bridged channel in `RESOURCE_SCOPED_CHANNELS`, there is
 * the single global delivery.
 *
 * Why this is the *deterministic* half of duplicate delivery: unlike
 * a reconnect overlap, this double-delivery needs no make-before-break
 * race — it happens on any steady-state resource-subscribed connection.
 * (The reconnect-overlap half is guarded below the Browser: one id per frame
 * on every connection, `tests/conformance/gateway/stream.test.ts`, and the
 * client's overlap dedup,
 * `packages/http-transport/src/transport/__tests__/actor-state-unit.test.ts`.)
 *
 * Signal: `[bus RECV]` is logged at `actor-state-unit.ts` only for events that
 * pass the `seenEventIds` dedup, so `bus.receives(channel).length` is the
 * post-dedup client-bus delivery count — **2 with the overlap, 1 without**.
 *
 * Mechanics:
 *  - The PAGE holds the resource-subscribed connection (the one that
 *    would double-deliver); its console bus-log is what the `bus` fixture captures.
 *  - A parallel SDK client (same gateway/user, like spec 11) only *triggers*
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
    // source of a second, scoped delivery for a channel in both sets.
    await page.goto('/en/know/discover');
    const firstCard = page.getByRole('button', { name: /^open resource:/i }).first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await firstCard.click();
    await expect(page.getByText(/loading resource/i)).toBeHidden({ timeout: 30_000 });
    // Let the make-before-break scope reconnect fully settle, so the scoped
    // subscription is live AND the old (global-only) connection is gone before
    // we trigger the event. This keeps us out of the racy reconnect-overlap
    // path and isolates the deterministic global+scoped overlap.
    await page.waitForTimeout(2_000);

    // ── Trigger exactly one frame:tag-schema-added from a parallel client ──
    const session = await signInSession();
    const client = session.client;
    try {
      bus.clear();
      await client.frame.addTagSchema(DEDUP_SCHEMA);

      // The bridged broadcast must reach the page (≥1). If this times out,
      // `frame:tag-schema-added` isn't bridged at all (a different defect).
      await bus.waitForRecv('frame:tag-schema-added', { timeout: 10_000 });

      // A duplicate arrives on the same connection immediately after
      // the first copy; wait long enough that it would have arrived and been
      // ingested before we count.
      await page.waitForTimeout(2_000);

      const deliveries = bus.receives('frame:tag-schema-added');
      expect(
        deliveries.length,
        `frame:tag-schema-added must be delivered to a resource-subscribed page exactly once; ` +
          `${deliveries.length} means the channel sits in BRIDGED ∩ RESOURCE_SCOPED ` +
          `(global + scoped dual-forward). delivery scopes=${JSON.stringify(deliveries.map((d) => d.scope))}`,
      ).toBe(1);
    } finally {
      await session.dispose();
    }
  });
});
