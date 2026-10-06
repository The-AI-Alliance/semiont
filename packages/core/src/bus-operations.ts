// ⚠ GENERATED FILE — do not edit.
//
// Authority:   specs/src/bus/registry.json  (channels, payloads, operations)
// Regenerate:  node scripts/bus/generate-ts.mjs
// Go counterpart: node scripts/bus/generate-go.mjs → packages/sdk-go/bus
//
// Payload schemas themselves live in the OpenAPI components; the registry
// names which one each channel carries, and every payload type here is
// derived from that. Add or change a channel THERE.

import type { EventName, EmittableChannel } from './bus-protocol';

/**
 * BUS_OPERATIONS — the request/reply operations registry.
 *
 * Each entry declares ONE operation as a triple, so its three facts are
 * stated together rather than maintained independently across call sites:
 *   - the request channel (the key — an `EmittableChannel`),
 *   - the `result` channel (success reply),
 *   - and the `failure` channel.
 *
 * `BridgedChannel` / `BRIDGED_CHANNELS` are DERIVED from this map
 * (bridged-channels.ts): every reply lands in the bridged fan-in set by
 * construction, so "a reply channel forgotten from BRIDGED_CHANNELS" is not
 * representable.
 *
 * `Partial<Record<EmittableChannel, …>>` enforces that every key is a real
 * emittable request. `result`/`failure` stay `EventName` rather than
 * `BridgedChannel` to avoid a circular reference (BridgedChannel derives from
 * this map); the derivation closes the loop instead.
 */
export interface BusOperationSpec {
  result: EventName;
  failure: EventName;
}

export const BUS_OPERATIONS = {
  // ── BIND ────────────────────────────────────────────────────────
  'bind:update-body':                    { result: 'bind:body-updated',              failure: 'bind:body-update-failed' },

  // ── BROWSE (reads) ──────────────────────────────────────────────
  'browse:resource-requested':           { result: 'browse:resource-result',         failure: 'browse:resource-failed' },
  'browse:anchored-text-requested':      { result: 'browse:anchored-text-result',    failure: 'browse:anchored-text-failed' },
  'browse:resources-requested':          { result: 'browse:resources-result',        failure: 'browse:resources-failed' },
  'browse:annotation-requested':         { result: 'browse:annotation-result',       failure: 'browse:annotation-failed' },
  'browse:annotations-requested':        { result: 'browse:annotations-result',      failure: 'browse:annotations-failed' },
  'browse:annotation-history-requested': { result: 'browse:annotation-history-result', failure: 'browse:annotation-history-failed' },
  'browse:events-requested':             { result: 'browse:events-result',           failure: 'browse:events-failed' },
  'browse:entity-types-requested':       { result: 'browse:entity-types-result',     failure: 'browse:entity-types-failed' },
  'browse:tag-schemas-requested':        { result: 'browse:tag-schemas-result',      failure: 'browse:tag-schemas-failed' },
  'browse:agents-requested':             { result: 'browse:agents-result',           failure: 'browse:agents-failed' },
  'browse:kb-requested':                 { result: 'browse:kb-result',               failure: 'browse:kb-failed' },
  'browse:directory-requested':          { result: 'browse:directory-result',        failure: 'browse:directory-failed' },
  // dormant — handler registered, no client caller (annotation-detail capability)
  'browse:annotation-context-requested': { result: 'browse:annotation-context-result', failure: 'browse:annotation-context-failed' },

  // ── FRAME (KB schema writes) ────────────────────────────────────
  'frame:add-entity-type':               { result: 'frame:entity-type-add-ok',       failure: 'frame:entity-type-add-failed' },
  'frame:add-tag-schema':                { result: 'frame:tag-schema-add-ok',        failure: 'frame:tag-schema-add-failed' },

  // ── GATHER ──────────────────────────────────────────────────────
  'gather:requested':                    { result: 'gather:complete',                failure: 'gather:failed' },
  'gather:resource-requested':           { result: 'gather:resource-complete',       failure: 'gather:resource-failed' },
  // dormant — handler registered, no client caller (annotation summary)
  'gather:summary-requested':            { result: 'gather:summary-result',          failure: 'gather:summary-failed' },
  'gather:referenced-by-requested':      { result: 'gather:referenced-by-result',    failure: 'gather:referenced-by-failed' },
  'gather:limits-requested':             { result: 'gather:limits-result',           failure: 'gather:limits-failed' },

  // ── JOB ─────────────────────────────────────────────────────────
  'job:create':                          { result: 'job:created',                    failure: 'job:create-failed' },
  'job:status-requested':                { result: 'job:status-result',              failure: 'job:status-failed' },
  'job:limits-requested':                { result: 'job:limits-result',              failure: 'job:limits-failed' },
  'job:cancel-requested':                { result: 'job:cancel-ok',                  failure: 'job:cancel-failed' },
  // worker-side: the worker claims a queued job (not an SDK call)
  'job:claim':                           { result: 'job:claimed',                    failure: 'job:claim-failed' },

  // ── MARK ────────────────────────────────────────────────────────
  'mark:create-request':                 { result: 'mark:create-ok',                 failure: 'mark:create-failed' },
  'mark:commit':                         { result: 'mark:commit-ok',                 failure: 'mark:commit-failed' },
  'mark:delete':                         { result: 'mark:delete-ok',                 failure: 'mark:delete-failed' },
  'mark:archive':                        { result: 'mark:archive-ok',                failure: 'mark:archive-failed' },
  'mark:unarchive':                      { result: 'mark:unarchive-ok',              failure: 'mark:unarchive-failed' },
  'mark:update-entity-types':            { result: 'mark:update-entity-types-ok',    failure: 'mark:update-entity-types-failed' },

  // ── MATCH ───────────────────────────────────────────────────────
  // take-1 dressed as an Observable in the SDK
  'match:search-requested':              { result: 'match:search-results',           failure: 'match:search-failed' },
  'match:resources-requested':           { result: 'match:resources-result',         failure: 'match:resources-failed' },
  'match:limits-requested':              { result: 'match:limits-result',            failure: 'match:limits-failed' },

  // ── WEAVE ───────────────────────────────────────────────────────
  // Graph-projection rebuild, served by the Weaver
  'weave:rebuild':                       { result: 'weave:rebuild-ok',               failure: 'weave:rebuild-failed' },

  // ── SMELT ────────────────────────────────────────────
  // Anchored-text rebuild, served by the Smelter
  'smelt:rebuild-anchors':               { result: 'smelt:rebuild-anchors-ok',       failure: 'smelt:rebuild-anchors-failed' },

  // ── YIELD ───────────────────────────────────────────────────────
  // clients refresh on the persisted `yield:created`, never on the -ok reply
  'yield:create':                        { result: 'yield:create-ok',                failure: 'yield:create-failed' },
  'yield:clone-persist':                 { result: 'yield:clone-persist-ok',         failure: 'yield:clone-persist-failed' },
  // dormant — handler in stower exists, no request emitter
  'yield:update':                        { result: 'yield:update-ok',                failure: 'yield:update-failed' },
  'yield:clone-create':                  { result: 'yield:clone-created',            failure: 'yield:clone-create-failed' },
  'yield:clone-resource-requested':      { result: 'yield:clone-resource-result',    failure: 'yield:clone-resource-failed' },
  'yield:clone-token-requested':         { result: 'yield:clone-token-generated',    failure: 'yield:clone-token-failed' },
} as const satisfies Partial<Record<EmittableChannel, BusOperationSpec>>;

/** The request-channel key of a registered operation — what `busRequest` takes. */
export type BusOperationKey = keyof typeof BUS_OPERATIONS;
