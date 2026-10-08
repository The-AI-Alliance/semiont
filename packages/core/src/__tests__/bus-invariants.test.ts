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
 *   - scoped     — delivered per resource scope → `RESOURCE_SCOPED_CHANNELS`.
 *                                                                 bridged-channels.ts
 *
 * The defects these guards exclude are *cross-list* inconsistencies, not
 * within-list ones:
 *   - a reply channel missing from BRIDGED_CHANNELS → silent 30 s timeout;
 *   - a channel in *both* BRIDGED and the scoped set → double delivery.
 *
 * Each declared list is guarded at compile time by a `satisfies` clause —
 * `readonly EventName[]` (BRIDGED_BROADCASTS, RESOURCE_SCOPED_CHANNELS),
 * `readonly PersistedEventType[]` (PERSISTED_EVENT_TYPES),
 * `Record<EventName, …>` (CHANNEL_SCHEMAS) — so a typo'd or stale channel name
 * is a build error. This file pins the remaining invariants the type system
 * can't express: array shape (no duplicates) and cross-list set relations.
 *
 * NOT checked here: "every reply channel is bridged." A channel must be bridged
 * iff it has a *remote* (SSE/HttpTransport) consumer, which is encoded only in
 * `busRequest` calls — and those already constrain their result/failure channels
 * to `BridgedChannel` at compile time. Reply-*named* channels whose only
 * consumers are in-process are correctly unbridged (e.g. `yield:move-failed`: the
 * CLI `mv` command has no remote SDK surface, so nothing remote awaits it), so a
 * name-based scan would be all false positives. "Is a remote reply" is data in
 * `BUS_OPERATIONS`, which the bridged set derives from.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CHANNEL_ATTRS } from '../bus-classification';
import { BRIDGED_CHANNELS } from '../bridged-channels';
import { BUS_OPERATIONS } from '../bus-operations';
import { PERSISTED_EVENT_TYPES } from '../persisted-events';

/**
 * `BRIDGED_CHANNELS` is DERIVED from `BUS_OPERATIONS` (every op's
 * result/failure) plus `BRIDGED_BROADCASTS`. This frozen snapshot is the set
 * it must equal: if an operation is ever missed or mistyped, the derived set
 * diverges from this snapshot and the test goes red — so no reply channel can
 * silently drop. Edit this snapshot ONLY for a deliberate, reviewed change to
 * the bridged set.
 *
 * `job:queued` is deliberately absent: its audience is `declared`, so it
 * reaches only a client whose manifest names it — a worker
 * (`JOB_CLAIM_CHANNELS` in @semiont/sdk).
 */
const FROZEN_BRIDGED = [
  'browse:resources-result', 'browse:resources-failed',
  'browse:resource-result', 'browse:resource-failed',
  'browse:anchored-text-result', 'browse:anchored-text-failed',
  'browse:annotations-result', 'browse:annotations-failed',
  'browse:annotation-result', 'browse:annotation-failed',
  'browse:annotation-history-result', 'browse:annotation-history-failed',
  'browse:events-result', 'browse:events-failed',
  'browse:entity-types-result', 'browse:entity-types-failed',
  'browse:tag-schemas-result', 'browse:tag-schemas-failed',
  'browse:agents-result', 'browse:agents-failed',
  'browse:kb-result', 'browse:kb-failed',
  'browse:directory-result', 'browse:directory-failed',
  'mark:delete-ok', 'mark:delete-failed',
  'mark:create-ok', 'mark:create-failed',
  'mark:commit-ok', 'mark:commit-failed',
  'mark:archive-ok', 'mark:archive-failed',
  'mark:unarchive-ok', 'mark:unarchive-failed',
  'mark:update-entity-types-ok', 'mark:update-entity-types-failed',
  'match:search-results', 'match:search-failed',
  'match:resources-result', 'match:resources-failed',
  'match:limits-result', 'match:limits-failed',
  'weave:rebuild-ok', 'weave:rebuild-failed',
  'smelt:rebuild-anchors-ok', 'smelt:rebuild-anchors-failed',
  'gather:complete', 'gather:failed',
  'gather:resource-complete', 'gather:resource-failed',
  'gather:summary-result', 'gather:summary-failed',
  'gather:referenced-by-result', 'gather:referenced-by-failed',
  'gather:limits-result', 'gather:limits-failed',
  'bind:body-updated', 'bind:body-update-failed',
  'job:report-progress', 'job:complete', 'job:fail',
  'smelt:settled',
  'job:status-result', 'job:status-failed',
  'job:limits-result', 'job:limits-failed',
  'job:created', 'job:create-failed',
  'job:claimed', 'job:claim-failed',
  'job:cancel-ok', 'job:cancel-failed',
  'yield:create-ok', 'yield:create-failed',
  'yield:clone-persist-ok', 'yield:clone-persist-failed',
  'yield:update-ok', 'yield:update-failed',
  'yield:clone-token-generated', 'yield:clone-token-failed',
  'yield:clone-resource-result', 'yield:clone-resource-failed',
  'yield:clone-created', 'yield:clone-create-failed',
  'frame:entity-type-added', 'frame:tag-schema-added',
  // The resource domain events, bridged so a NON-requesting client learns
  // that a resource appeared, changed, was cloned or was renamed. Replies are
  // owner-routed (written only to the client that made the request), so a
  // `yield:*-ok` reply cannot double as a broadcast.
  'yield:created', 'yield:updated', 'yield:cloned', 'yield:moved',
  'frame:entity-type-add-ok', 'frame:entity-type-add-failed',
  'frame:tag-schema-add-ok', 'frame:tag-schema-add-failed',
  'beckon:focus', 'beckon:sparkle',
  'bus:resume-gap',
  // The guided tour's imperative — domain intent, bridged so a launcher emit
  // reaches every watching Browser (nav:* is framework routing and stays
  // host-local).
  'browse:resource-open',
  // The guided tour's REPORT — the viewer announces arrival (by cue, link,
  // back button, or typed URL) so the guide can branch on it. Never the
  // imperative `browse:resource-open`: drive and report stay separate, so one
  // viewer's click cannot drive another's page.
  'browse:resource-viewed',
  // The guided tour's presence. SSE connection lifecycle, not login — a
  // token can be minted and never used, so what a tour needs is whether
  // anyone is WATCHING. Bridged because the watcher and the watcher's guide
  // are different processes.
  'session:joined',
  'session:left',
  // The guided tour's fourth drive — OPEN an annotation (panel entry
  // selected, then relayed to beckon:focus for the scroll), where focus only
  // points at one. Bridging is fan-IN only, so the eight in-browser
  // `browse.click()` emitters stay local exactly as `browse.openResource()`
  // does; the wire emitter is `beckon.click()`.
  'browse:click',
];

describe('bus channel-classification invariants', () => {
  it('mark:update-entity-types is a registered operation with correlated -ok/-failed replies', () => {
    // A resource's own entity-type classification is a confirmed gateway write —
    // registered like its sibling metadata mutations (mark:delete/archive) so the
    // SDK's busRequest awaits the correlation-keyed reply and rejects on failure,
    // NOT a fire-and-forget local emit whose failure has nowhere to go.
    // Widened to a plain Record so this reads as a runtime registry assertion
    // rather than a compile error on a missing `as const` key.
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
    // A duplicate makes the gateway SSE forwarder subscribe to the channel
    // twice — it maps `?channel=` entries 1:1 to subscriptions with no dedup —
    // so every event on it is delivered twice. The `BridgedChannel` *type*
    // can't catch this: a tuple with a repeated literal collapses in the
    // `[number]` union.
    const dups = BRIDGED_CHANNELS.filter((c, i) => BRIDGED_CHANNELS.indexOf(c) !== i);
    expect(dups).toEqual([]);
  });

  it('the only channels both globally bridged and persisted are the KB-global frame:* and yield:* events', () => {
    // A channel in BOTH BRIDGED_CHANNELS and PERSISTED_EVENT_TYPES is a recorded
    // event every client hears on no scope. Delivered per resource scope as
    // well, it would be forwarded once on each path under two different SSE
    // ids, which dedup cannot collapse. It is legitimate only for KB-global
    // events (every client wants them; no single resource owns them), which
    // RESOURCE_SCOPED_CHANNELS must not hold (enforced by
    // @semiont/http-transport's bus-invariants test).
    //
    // A NEW entry here is a conscious design decision, not an oversight: confirm
    // the channel is genuinely KB-global, confirm it is absent from
    // RESOURCE_SCOPED_CHANNELS, then add it to the expected set below.
    //
    // The `yield:*` four are here deliberately, so a non-requesting client
    // learns that a resource changed, and they pass the three confirmations
    // that gate this list:
    //  1. KB-global? YES. Their consumer is the resource LIST cache, which is
    //     unscoped by construction (`resources()` never calls `withScope`) —
    //     and a CREATE cannot be scoped at all, since no client can hold a
    //     scope on a resource that does not exist yet. Scoped delivery
    //     therefore cannot serve this use case.
    //  2. Absent from RESOURCE_SCOPED_CHANNELS? YES: the registry declares one
    //     audience per channel and theirs is `everyone`, and http-transport's
    //     own bus-invariants test enforces the exclusion.
    //  3. What it costs: broadcasts carry no Last-Event-ID replay, so a
    //     client disconnected across one of these misses the invalidation and
    //     shows a stale list until its next fetch — the same property
    //     `frame:*` has.
    const persisted = new Set<string>(PERSISTED_EVENT_TYPES);
    const overlap = BRIDGED_CHANNELS.filter((c) => persisted.has(c)).sort();
    expect(overlap).toEqual([
      'frame:entity-type-added', 'frame:tag-schema-added',
      'yield:cloned', 'yield:created', 'yield:moved', 'yield:updated',
    ]);
  });
});

/**
 * Browse answers from the record; finding things is the Librarian's. A listing
 * cannot search, and what refers to a resource is asked of Gather.
 */
describe('browse is retrieval, never discovery', () => {
  const schema = (name: string): { properties: Record<string, unknown>; required?: string[] } =>
    JSON.parse(readFileSync(resolve(__dirname, `../../../../specs/src/components/schemas/${name}.json`), 'utf8'));

  it('no browse channel asks what refers to a resource', () => {
    expect(Object.keys(CHANNEL_ATTRS).filter((channel) => channel.startsWith('browse:referenced-by'))).toEqual([]);
  });

  it('a listing request carries no search', () => {
    expect(Object.keys(schema('BrowseResourcesRequest').properties)).not.toContain('search');
  });

  it('a listing reply says nothing of how it matched: only a search does', () => {
    expect(Object.keys(schema('ListResourcesResponse').properties)).not.toContain('matchKind');
    expect(Object.keys(schema('MatchResourcesResponse').properties)).toContain('matchKind');
  });
});
