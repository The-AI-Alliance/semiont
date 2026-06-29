/**
 * Bus channel-classification invariants — the cross-list consistency contract.
 *
 * A bus channel carries several independent properties, each declared in a
 * different place:
 *   - emittable  — non-null `CHANNEL_SCHEMAS` entry → `EmittableChannel`
 *                  (validated by the `/bus/emit` gateway).        bus-protocol.ts
 *   - bridged    — transports subscribe to it over SSE → `BridgedChannel`.
 *                                                                 bridged-channels.ts
 *   - persisted  — logged to the event store, replayable → `PersistedEventType`.
 *                                                                 persisted-events.ts
 *   - scoped     — delivered on a resource-scoped bus →
 *                  `RESOURCE_SCOPED_CHANNELS` (derived in @semiont/http-transport).
 *
 * The bugs that motivated these guards were all *cross-list* inconsistencies,
 * not within-list ones:
 *   - a reply channel missing from BRIDGED_CHANNELS → silent 30 s timeout
 *     (.plans/bugs/gather-resource-complete-not-bridged.md);
 *   - a channel in *both* BRIDGED and the scoped set → double delivery
 *     (.plans/bugs/BRIDGE-GAPS.md).
 *
 * Each list is now guarded at compile time by an `as const satisfies
 * readonly EventName[]` clause (BRIDGED_CHANNELS, PERSISTED_EVENT_TYPES,
 * RESOURCE_BROADCAST_TYPES) or `satisfies Record<EventName, …>`
 * (CHANNEL_SCHEMAS) — so a typo'd or stale channel name is a build error. This
 * file pins the remaining invariants the type system can't express: array shape
 * (no duplicates) and cross-list set relations.
 *
 * NOT checked here: "every reply channel is bridged." A channel must be bridged
 * iff it has a *remote* (SSE/HttpTransport) consumer, which is encoded only in
 * `busRequest` calls — and those already constrain their result/failure channels
 * to `BridgedChannel` at compile time. Reply-*named* channels whose only
 * consumers are in-process are correctly unbridged (e.g. `yield:move-failed`: the
 * CLI `mv` command has no remote SDK surface, so nothing remote awaits it), so a
 * name-based scan would be all false positives. Turning "is a remote reply" into
 * data is the Tier 1 operations-registry step.
 */

import { describe, it, expect } from 'vitest';
import { BRIDGED_CHANNELS } from '../bridged-channels';
import { PERSISTED_EVENT_TYPES } from '../persisted-events';

describe('bus channel-classification invariants', () => {
  it('BRIDGED_CHANNELS has no duplicate entries', () => {
    // A duplicate makes the backend SSE forwarder subscribe to the channel
    // twice — it maps `?channel=` entries 1:1 to subscriptions with no dedup —
    // so every event on it is delivered twice. The `BridgedChannel` *type*
    // can't catch this: a tuple with a repeated literal collapses in the
    // `[number]` union. See .plans/bugs/BRIDGE-GAPS.md.
    const dups = BRIDGED_CHANNELS.filter((c, i) => BRIDGED_CHANNELS.indexOf(c) !== i);
    expect(dups).toEqual([]);
  });

  it('the only globally-bridged channels that are also persisted (scoped) are the KB-global frame:* events', () => {
    // A channel in BOTH BRIDGED_CHANNELS and PERSISTED_EVENT_TYPES is delivered
    // globally (bridged) *and* is a resource-scoped persisted event — the exact
    // double-delivery shape from BRIDGE-GAPS.md. It is legitimate only for the
    // KB-global schema events (every client wants them; no single resource owns
    // them), which @semiont/http-transport excludes from its scoped
    // subscription (enforced by that package's bus-invariants test).
    //
    // A NEW entry here is a conscious design decision, not an oversight: confirm
    // the channel is genuinely KB-global, confirm http-transport still excludes
    // it from RESOURCE_SCOPED_CHANNELS, then add it to the expected set below.
    const persisted = new Set<string>(PERSISTED_EVENT_TYPES);
    const overlap = BRIDGED_CHANNELS.filter((c) => persisted.has(c)).sort();
    expect(overlap).toEqual(['frame:entity-type-added', 'frame:tag-schema-added']);
  });
});
