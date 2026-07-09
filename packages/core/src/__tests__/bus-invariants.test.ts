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
import { BUS_OPERATIONS } from '../bus-operations';
import { PERSISTED_EVENT_TYPES } from '../persisted-events';

/**
 * The Tier-1 migration safety net. `BRIDGED_CHANNELS` is now DERIVED from
 * `BUS_OPERATIONS` (every op's result/failure/progress) plus `BRIDGED_BROADCASTS`
 * — see .plans/BUS-OPERATIONS-REGISTRY.md. This frozen snapshot is the exact set
 * the old hand-list carried (minus the reaped dead `gather:annotation-finished`).
 * If an operation is ever missed or mistyped, the derived set diverges from this
 * snapshot and the test goes red — so no reply channel can silently drop. Edit
 * this snapshot ONLY for a deliberate, reviewed change to the bridged set.
 */
const FROZEN_BRIDGED = [
  'browse:resources-result', 'browse:resources-failed',
  'browse:resource-result', 'browse:resource-failed',
  'browse:annotations-result', 'browse:annotations-failed',
  'browse:annotation-result', 'browse:annotation-failed',
  'browse:annotation-history-result', 'browse:annotation-history-failed',
  'browse:events-result', 'browse:events-failed',
  'browse:referenced-by-result', 'browse:referenced-by-failed',
  'browse:entity-types-result', 'browse:entity-types-failed',
  'browse:tag-schemas-result', 'browse:tag-schemas-failed',
  'browse:agents-result', 'browse:agents-failed',
  'browse:directory-result', 'browse:directory-failed',
  'browse:annotation-context-result', 'browse:annotation-context-failed',
  'mark:delete-ok', 'mark:delete-failed',
  'mark:create-ok', 'mark:create-failed',
  'mark:archive-ok', 'mark:archive-failed',
  'mark:unarchive-ok', 'mark:unarchive-failed',
  'mark:update-entity-types-ok', 'mark:update-entity-types-failed',
  'match:search-results', 'match:search-failed',
  'gather:complete', 'gather:failed',
  'gather:resource-complete', 'gather:resource-failed',
  'gather:annotation-progress',
  'gather:summary-result', 'gather:summary-failed',
  'bind:body-updated', 'bind:body-update-failed',
  'job:report-progress', 'job:complete', 'job:fail',
  'job:status-result', 'job:status-failed',
  'job:created', 'job:create-failed',
  'job:claimed', 'job:claim-failed',
  'job:cancel-ok', 'job:cancel-failed',
  'yield:create-ok', 'yield:create-failed',
  'yield:update-ok', 'yield:update-failed',
  'yield:clone-token-generated', 'yield:clone-token-failed',
  'yield:clone-resource-result', 'yield:clone-resource-failed',
  'yield:clone-created', 'yield:clone-create-failed',
  'frame:entity-type-added', 'frame:tag-schema-added',
  'frame:entity-type-add-ok', 'frame:entity-type-add-failed',
  'frame:tag-schema-add-ok', 'frame:tag-schema-add-failed',
  'beckon:focus', 'beckon:sparkle',
  'bus:resume-gap',
];

describe('bus channel-classification invariants', () => {
  it('mark:update-entity-types is a registered operation with correlated -ok/-failed replies', () => {
    // A resource's own entity-type classification is a confirmed backend write —
    // registered like its sibling metadata mutations (mark:delete/archive) so the
    // SDK's busRequest awaits the correlation-keyed reply and rejects on failure,
    // NOT a fire-and-forget local emit whose failure has nowhere to go
    // (.plans/bugs/BRIDGE-GAPS.md). Widened to a plain Record so this reads as a
    // runtime registry assertion (RED before the operation is registered) rather
    // than a compile error on a missing `as const` key.
    const ops = BUS_OPERATIONS as Record<string, { result: string; failure: string }>;
    expect(ops['mark:update-entity-types']).toEqual({
      result: 'mark:update-entity-types-ok',
      failure: 'mark:update-entity-types-failed',
    });
  });

  it('the derived BRIDGED_CHANNELS equals the frozen registry snapshot', () => {
    expect(new Set(BRIDGED_CHANNELS)).toEqual(new Set(FROZEN_BRIDGED));
    // guard against an accidental duplicate inflating the array length without
    // changing the set (the no-dup test below also covers this, belt-and-braces)
    expect(BRIDGED_CHANNELS.length).toBe(FROZEN_BRIDGED.length);
  });

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
