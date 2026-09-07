import type { EventName } from './bus-protocol';
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
export declare const BUS_OPERATIONS: {
    readonly 'bind:update-body': {
        readonly result: "bind:body-updated";
        readonly failure: "bind:body-update-failed";
    };
    readonly 'browse:resource-requested': {
        readonly result: "browse:resource-result";
        readonly failure: "browse:resource-failed";
    };
    readonly 'browse:anchored-text-requested': {
        readonly result: "browse:anchored-text-result";
        readonly failure: "browse:anchored-text-failed";
    };
    readonly 'browse:resources-requested': {
        readonly result: "browse:resources-result";
        readonly failure: "browse:resources-failed";
    };
    readonly 'browse:annotation-requested': {
        readonly result: "browse:annotation-result";
        readonly failure: "browse:annotation-failed";
    };
    readonly 'browse:annotations-requested': {
        readonly result: "browse:annotations-result";
        readonly failure: "browse:annotations-failed";
    };
    readonly 'browse:annotation-history-requested': {
        readonly result: "browse:annotation-history-result";
        readonly failure: "browse:annotation-history-failed";
    };
    readonly 'browse:events-requested': {
        readonly result: "browse:events-result";
        readonly failure: "browse:events-failed";
    };
    readonly 'browse:referenced-by-requested': {
        readonly result: "browse:referenced-by-result";
        readonly failure: "browse:referenced-by-failed";
    };
    readonly 'browse:entity-types-requested': {
        readonly result: "browse:entity-types-result";
        readonly failure: "browse:entity-types-failed";
    };
    readonly 'browse:tag-schemas-requested': {
        readonly result: "browse:tag-schemas-result";
        readonly failure: "browse:tag-schemas-failed";
    };
    readonly 'browse:agents-requested': {
        readonly result: "browse:agents-result";
        readonly failure: "browse:agents-failed";
    };
    readonly 'browse:directory-requested': {
        readonly result: "browse:directory-result";
        readonly failure: "browse:directory-failed";
    };
    readonly 'browse:annotation-context-requested': {
        readonly result: "browse:annotation-context-result";
        readonly failure: "browse:annotation-context-failed";
    };
    readonly 'frame:add-entity-type': {
        readonly result: "frame:entity-type-add-ok";
        readonly failure: "frame:entity-type-add-failed";
    };
    readonly 'frame:add-tag-schema': {
        readonly result: "frame:tag-schema-add-ok";
        readonly failure: "frame:tag-schema-add-failed";
    };
    readonly 'gather:requested': {
        readonly result: "gather:complete";
        readonly failure: "gather:failed";
        readonly progress: "gather:annotation-progress";
    };
    readonly 'gather:resource-requested': {
        readonly result: "gather:resource-complete";
        readonly failure: "gather:resource-failed";
    };
    readonly 'gather:summary-requested': {
        readonly result: "gather:summary-result";
        readonly failure: "gather:summary-failed";
    };
    readonly 'job:create': {
        readonly result: "job:created";
        readonly failure: "job:create-failed";
    };
    readonly 'job:status-requested': {
        readonly result: "job:status-result";
        readonly failure: "job:status-failed";
    };
    readonly 'job:cancel-requested': {
        readonly result: "job:cancel-ok";
        readonly failure: "job:cancel-failed";
    };
    readonly 'job:claim': {
        readonly result: "job:claimed";
        readonly failure: "job:claim-failed";
    };
    readonly 'mark:create-request': {
        readonly result: "mark:create-ok";
        readonly failure: "mark:create-failed";
    };
    readonly 'mark:commit': {
        readonly result: "mark:commit-ok";
        readonly failure: "mark:commit-failed";
    };
    readonly 'mark:delete': {
        readonly result: "mark:delete-ok";
        readonly failure: "mark:delete-failed";
    };
    readonly 'mark:archive': {
        readonly result: "mark:archive-ok";
        readonly failure: "mark:archive-failed";
    };
    readonly 'mark:unarchive': {
        readonly result: "mark:unarchive-ok";
        readonly failure: "mark:unarchive-failed";
    };
    readonly 'mark:update-entity-types': {
        readonly result: "mark:update-entity-types-ok";
        readonly failure: "mark:update-entity-types-failed";
    };
    readonly 'match:search-requested': {
        readonly result: "match:search-results";
        readonly failure: "match:search-failed";
    };
    readonly 'weave:rebuild': {
        readonly result: "weave:rebuild-ok";
        readonly failure: "weave:rebuild-failed";
    };
    readonly 'smelt:rebuild-anchors': {
        readonly result: "smelt:rebuild-anchors-ok";
        readonly failure: "smelt:rebuild-anchors-failed";
    };
    readonly 'yield:create': {
        readonly result: "yield:create-ok";
        readonly failure: "yield:create-failed";
    };
    readonly 'yield:clone-persist': {
        readonly result: "yield:clone-persist-ok";
        readonly failure: "yield:clone-persist-failed";
    };
    readonly 'yield:update': {
        readonly result: "yield:update-ok";
        readonly failure: "yield:update-failed";
    };
    readonly 'yield:clone-create': {
        readonly result: "yield:clone-created";
        readonly failure: "yield:clone-create-failed";
    };
    readonly 'yield:clone-resource-requested': {
        readonly result: "yield:clone-resource-result";
        readonly failure: "yield:clone-resource-failed";
    };
    readonly 'yield:clone-token-requested': {
        readonly result: "yield:clone-token-generated";
        readonly failure: "yield:clone-token-failed";
    };
};
/** The request-channel key of a registered operation — what `busRequest` takes. */
export type BusOperationKey = keyof typeof BUS_OPERATIONS;
