import type { EventName, EmittableChannel } from './bus-protocol';

/**
 * BUS_OPERATIONS — the request/reply operations registry (Tier 1).
 *
 * Each entry declares ONE operation as the triple that was previously three
 * loose, independently-maintained facts spread across call sites:
 *   - the request channel (the key — an `EmittableChannel`),
 *   - the `result` channel (success reply),
 *   - the `failure` channel,
 *   - and, for a streaming op, an optional `progress` channel.
 *
 * `BridgedChannel` / `BRIDGED_CHANNELS` are DERIVED from this map
 * (bridged-channels.ts): every reply lands in the bridged fan-in set by
 * construction, so "a reply channel forgotten from BRIDGED_CHANNELS" — the
 * recurring bug class (gather:resource-complete, frame:*-add-failed) — is no
 * longer representable. See .plans/BUS-OPERATIONS-REGISTRY.md.
 *
 * `Partial<Record<EmittableChannel, …>>` enforces that every key is a real
 * emittable request. `result`/`failure`/`progress` stay `EventName` rather than
 * `BridgedChannel` to avoid a circular reference (BridgedChannel derives from
 * this map); the derivation closes the loop instead.
 */
export interface BusOperationSpec {
  result: EventName;
  failure: EventName;
  /** Streaming ops only: an intermediate channel that also bridges. */
  progress?: EventName;
}

export const BUS_OPERATIONS = {
  // ── BIND ────────────────────────────────────────────────────────
  'bind:update-body':                    { result: 'bind:body-updated',              failure: 'bind:body-update-failed' },

  // ── BROWSE (reads) ──────────────────────────────────────────────
  'browse:resource-requested':           { result: 'browse:resource-result',         failure: 'browse:resource-failed' },
  'browse:resources-requested':          { result: 'browse:resources-result',        failure: 'browse:resources-failed' },
  'browse:annotation-requested':         { result: 'browse:annotation-result',       failure: 'browse:annotation-failed' },
  'browse:annotations-requested':        { result: 'browse:annotations-result',      failure: 'browse:annotations-failed' },
  'browse:annotation-history-requested': { result: 'browse:annotation-history-result', failure: 'browse:annotation-history-failed' },
  'browse:events-requested':             { result: 'browse:events-result',           failure: 'browse:events-failed' },
  'browse:referenced-by-requested':      { result: 'browse:referenced-by-result',    failure: 'browse:referenced-by-failed' },
  'browse:entity-types-requested':       { result: 'browse:entity-types-result',     failure: 'browse:entity-types-failed' },
  'browse:tag-schemas-requested':        { result: 'browse:tag-schemas-result',      failure: 'browse:tag-schemas-failed' },
  'browse:agents-requested':             { result: 'browse:agents-result',           failure: 'browse:agents-failed' },
  'browse:directory-requested':          { result: 'browse:directory-result',        failure: 'browse:directory-failed' },
  // dormant — backend handler complete, no client caller yet (annotation-detail capability)
  'browse:annotation-context-requested': { result: 'browse:annotation-context-result', failure: 'browse:annotation-context-failed' },

  // ── FRAME (KB schema writes) ────────────────────────────────────
  'frame:add-entity-type':               { result: 'frame:entity-type-add-ok',       failure: 'frame:entity-type-add-failed' },
  'frame:add-tag-schema':                { result: 'frame:tag-schema-add-ok',        failure: 'frame:tag-schema-add-failed' },

  // ── GATHER ──────────────────────────────────────────────────────
  // streaming: take-1 result + failure plus an intermediate progress channel
  'gather:requested':                    { result: 'gather:complete',                failure: 'gather:failed', progress: 'gather:annotation-progress' },
  'gather:resource-requested':           { result: 'gather:resource-complete',       failure: 'gather:resource-failed' },
  // dormant — backend handler complete, no client caller yet (annotation summary)
  'gather:summary-requested':            { result: 'gather:summary-result',          failure: 'gather:summary-failed' },

  // ── JOB ─────────────────────────────────────────────────────────
  'job:create':                          { result: 'job:created',                    failure: 'job:create-failed' },
  'job:status-requested':                { result: 'job:status-result',              failure: 'job:status-failed' },
  'job:cancel-requested':                { result: 'job:cancel-ok',                  failure: 'job:cancel-failed' },
  // worker-side: the worker claims a queued job (not an SDK call)
  'job:claim':                           { result: 'job:claimed',                    failure: 'job:claim-failed' },

  // ── MARK ────────────────────────────────────────────────────────
  'mark:create-request':                 { result: 'mark:create-ok',                 failure: 'mark:create-failed' },
  'mark:delete':                         { result: 'mark:delete-ok',                 failure: 'mark:delete-failed' },
  'mark:archive':                        { result: 'mark:archive-ok',                failure: 'mark:archive-failed' },
  'mark:unarchive':                      { result: 'mark:unarchive-ok',              failure: 'mark:unarchive-failed' },
  'mark:update-entity-types':            { result: 'mark:update-entity-types-ok',    failure: 'mark:update-entity-types-failed' },

  // ── MATCH ───────────────────────────────────────────────────────
  // take-1 dressed as an Observable in the SDK; no progress channel
  'match:search-requested':              { result: 'match:search-results',           failure: 'match:search-failed' },

  // ── YIELD ───────────────────────────────────────────────────────
  // live in-process (resource-operations.ts emits + awaits via race()); the
  // client also .on()-subscribes -ok for cache invalidation
  'yield:create':                        { result: 'yield:create-ok',                failure: 'yield:create-failed' },
  // dormant — handler in stower exists, no request emitter; client pre-subscribes -ok
  'yield:update':                        { result: 'yield:update-ok',                failure: 'yield:update-failed' },
  'yield:clone-create':                  { result: 'yield:clone-created',            failure: 'yield:clone-create-failed' },
  'yield:clone-resource-requested':      { result: 'yield:clone-resource-result',    failure: 'yield:clone-resource-failed' },
  'yield:clone-token-requested':         { result: 'yield:clone-token-generated',    failure: 'yield:clone-token-failed' },
} as const satisfies Partial<Record<EmittableChannel, BusOperationSpec>>;

/** The request-channel key of a registered operation — what `busRequest` takes. */
export type BusOperationKey = keyof typeof BUS_OPERATIONS;
