/**
 * Bus Protocol
 *
 * The complete EventMap for the RxJS EventBus. Every channel name and
 * its payload type is defined here — domain events, commands, reads,
 * results, SSE stream payloads, and Browser UI events.
 *
 * Identifier discipline: where a payload carries an annotation or
 * resource id, the TypeScript layer narrows the OpenAPI `string` to the
 * branded type (`AnnotationId`, `ResourceId`, `UserId`). The runtime
 * wire shape is unchanged (brands have no runtime representation);
 * what this buys us is that command handlers don't have to re-brand
 * at every seam. Brand once at the entry boundary (HTTP route handler,
 * DOM attribute read, URL param parse), not at every bus hop in
 * between. See `.plans/BRAND-UPSTREAM.md` for the rationale.
 *
 * Organized by flow (verb), then by category within each flow.
 */
import type { components } from './types';
import type { AnnotationId, ResourceId } from './identifiers';
import type { Annotation } from './annotation-types';
import type { ResourceDescriptor } from './graph';
import type { StoredEvent } from './event-base';
import type { EventOfType } from './persisted-events';
import type { AnchorRect } from './bus-ui-types';
type MarkDeleteCommand = components['schemas']['MarkDeleteCommand'] & {
    annotationId: AnnotationId;
    resourceId?: ResourceId;
};
type MarkUpdateBodyCommand = components['schemas']['MarkUpdateBodyCommand'] & {
    annotationId: AnnotationId;
    resourceId: ResourceId;
};
type BindInitiateCommand = components['schemas']['BindInitiateCommand'] & {
    annotationId: AnnotationId;
    resourceId: ResourceId;
};
type BindUpdateBodyCommand = components['schemas']['BindUpdateBodyCommand'] & {
    annotationId: AnnotationId;
    resourceId: ResourceId;
};
/**
 * The unified EventMap — every channel on the EventBus.
 *
 * Convention:
 * - Domain events (past tense): StoredEvent<Interface> — branded types
 * - Commands/reads/results/UI: OpenAPI schema refs — plain strings
 * - void: UI-only signals with no payload
 */
export type EventMap = {
    'yield:created': StoredEvent<EventOfType<'yield:created'>>;
    'yield:cloned': StoredEvent<EventOfType<'yield:cloned'>>;
    'yield:updated': StoredEvent<EventOfType<'yield:updated'>>;
    'yield:moved': StoredEvent<EventOfType<'yield:moved'>>;
    'yield:representation-added': StoredEvent<EventOfType<'yield:representation-added'>>;
    'yield:representation-removed': StoredEvent<EventOfType<'yield:representation-removed'>>;
    'yield:create': components['schemas']['YieldCreateCommand'];
    'yield:clone-persist': components['schemas']['YieldClonePersistCommand'];
    'yield:update': components['schemas']['YieldUpdateCommand'];
    'yield:mv': components['schemas']['YieldMvCommand'];
    'yield:clone': void;
    'yield:clone-token-requested': components['schemas']['YieldCloneTokenRequest'];
    'yield:clone-resource-requested': components['schemas']['YieldCloneResourceRequest'];
    'yield:clone-create': components['schemas']['YieldCloneCreateCommand'];
    'yield:create-ok': components['schemas']['YieldCreateOk'];
    'yield:create-failed': components['schemas']['CommandError'];
    'yield:clone-persist-ok': components['schemas']['YieldClonePersistOk'];
    'yield:clone-persist-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'yield:update-ok': components['schemas']['YieldUpdateOk'];
    'yield:update-failed': components['schemas']['CommandError'];
    'yield:move-failed': {
        fromUri: string;
    } & components['schemas']['CommandError'];
    'yield:clone-token-generated': {
        correlationId: string;
        response: components['schemas']['CloneResourceWithTokenResponse'];
    };
    'yield:clone-token-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'yield:clone-resource-result': {
        correlationId: string;
        response: components['schemas']['GetResourceByTokenResponse'];
    };
    'yield:clone-resource-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'yield:clone-created': components['schemas']['YieldCloneCreated'];
    'yield:clone-create-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'mark:added': StoredEvent<EventOfType<'mark:added'>>;
    'mark:removed': StoredEvent<EventOfType<'mark:removed'>>;
    'mark:body-updated': StoredEvent<EventOfType<'mark:body-updated'>>;
    'mark:entity-tag-added': StoredEvent<EventOfType<'mark:entity-tag-added'>>;
    'mark:entity-tag-removed': StoredEvent<EventOfType<'mark:entity-tag-removed'>>;
    'mark:archived': StoredEvent<EventOfType<'mark:archived'>>;
    'mark:unarchived': StoredEvent<EventOfType<'mark:unarchived'>>;
    'mark:create-request': components['schemas']['MarkCreateRequest'];
    'mark:create': components['schemas']['MarkCreateCommand'];
    'mark:delete': MarkDeleteCommand;
    'mark:update-body': MarkUpdateBodyCommand;
    'mark:archive': components['schemas']['MarkArchiveCommand'];
    'mark:unarchive': components['schemas']['MarkUnarchiveCommand'];
    'mark:update-entity-types': components['schemas']['MarkUpdateEntityTypesCommand'];
    'mark:create-ok': components['schemas']['MarkCreateOk'];
    'mark:create-failed': components['schemas']['CommandError'];
    /**
     * Persist a detection unit's annotations as ONE acknowledged batch
     * (JOB-RESTART-SAFETY P6). Answered only after every annotation is in
     * the event log, so a worker can gate unit completion on durability
     * instead of on emission — which is what makes an Archivist outage a
     * delay rather than silent data loss.
     */
    'mark:commit': components['schemas']['MarkCommitCommand'];
    'mark:commit-ok': components['schemas']['MarkCommitOk'];
    'mark:commit-failed': components['schemas']['CommandError'];
    'mark:delete-ok': components['schemas']['MarkDeleteOk'];
    'mark:delete-failed': components['schemas']['CommandError'];
    'mark:archive-ok': {
        correlationId?: string;
    };
    'mark:archive-failed': components['schemas']['CommandError'];
    'mark:unarchive-ok': {
        correlationId?: string;
    };
    'mark:unarchive-failed': components['schemas']['CommandError'];
    'mark:update-entity-types-ok': {
        correlationId?: string;
    };
    'mark:update-entity-types-failed': components['schemas']['CommandError'];
    'mark:body-update-failed': components['schemas']['CommandError'];
    'mark:select-comment': components['schemas']['SelectionData'];
    'mark:select-tag': components['schemas']['SelectionData'];
    'mark:select-assessment': components['schemas']['SelectionData'];
    'mark:select-reference': components['schemas']['SelectionData'];
    'mark:requested': components['schemas']['MarkRequestedEvent'];
    'mark:cancel-pending': void;
    'mark:submit': components['schemas']['MarkSubmitEvent'];
    'mark:assist-request': components['schemas']['MarkAssistRequestEvent'];
    'mark:progress-dismiss': void;
    'mark:assist-timeout': {
        resourceId: string;
        motivation: components['schemas']['Motivation'];
    };
    'mark:create-error': {
        resourceId: string;
        message: string;
    };
    'mark:delete-error': {
        resourceId: string;
        message: string;
    };
    'bind:body-error': {
        resourceId: string;
        message: string;
    };
    'frame:entity-type-added': StoredEvent<EventOfType<'frame:entity-type-added'>>;
    'frame:tag-schema-added': StoredEvent<EventOfType<'frame:tag-schema-added'>>;
    'frame:add-entity-type': components['schemas']['FrameAddEntityTypeCommand'];
    'frame:add-tag-schema': components['schemas']['FrameAddTagSchemaCommand'];
    'frame:entity-type-add-ok': {
        correlationId?: string;
    };
    'frame:entity-type-add-failed': components['schemas']['CommandError'];
    'frame:tag-schema-add-ok': {
        correlationId?: string;
    };
    'frame:tag-schema-add-failed': components['schemas']['CommandError'];
    'bind:initiate': BindInitiateCommand;
    'bind:update-body': BindUpdateBodyCommand;
    'bind:body-updated': components['schemas']['BindBodyUpdated'];
    'bind:body-update-failed': components['schemas']['CommandError'];
    'match:search-requested': components['schemas']['MatchSearchRequest'];
    'match:search-results': components['schemas']['MatchSearchResult'];
    'match:search-failed': components['schemas']['MatchSearchFailed'];
    'gather:requested': components['schemas']['GatherAnnotationRequest'];
    'gather:complete': components['schemas']['GatherAnnotationComplete'];
    'gather:failed': {
        correlationId: string;
        annotationId: string;
    } & components['schemas']['CommandError'];
    'gather:resource-requested': components['schemas']['GatherResourceRequest'];
    'gather:resource-complete': components['schemas']['GatherResourceComplete'];
    'gather:resource-failed': {
        correlationId: string;
        resourceId: string;
    } & components['schemas']['CommandError'];
    'gather:summary-requested': components['schemas']['GatherSummaryRequest'];
    'gather:summary-result': {
        correlationId: string;
        response: Record<string, unknown>;
    };
    'gather:summary-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'gather:annotation-progress': components['schemas']['GatherProgress'];
    'browse:resource-requested': components['schemas']['BrowseResourceRequest'];
    'browse:resource-result': {
        correlationId: string;
        response: Omit<components['schemas']['GetResourceResponse'], 'resource' | 'annotations' | 'entityReferences'> & {
            resource: ResourceDescriptor;
            annotations: Annotation[];
            entityReferences: Annotation[];
        };
    };
    'browse:resource-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:anchored-text-requested': components['schemas']['BrowseAnchoredTextRequest'];
    'browse:anchored-text-result': components['schemas']['BrowseAnchoredTextResult'];
    'browse:anchored-text-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:resources-requested': components['schemas']['BrowseResourcesRequest'];
    'browse:resources-result': {
        correlationId: string;
        response: Omit<components['schemas']['ListResourcesResponse'], 'resources'> & {
            resources: ResourceDescriptor[];
        };
    };
    'browse:resources-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:annotations-requested': components['schemas']['BrowseAnnotationsRequest'];
    'browse:annotations-result': {
        correlationId: string;
        response: Omit<components['schemas']['GetAnnotationsResponse'], 'annotations'> & {
            annotations: Annotation[];
        };
    };
    'browse:annotations-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:annotation-requested': components['schemas']['BrowseAnnotationRequest'];
    'browse:annotation-result': {
        correlationId: string;
        response: Omit<components['schemas']['GetAnnotationResponse'], 'annotation' | 'resource' | 'resolvedResource'> & {
            annotation: Annotation;
            resource: ResourceDescriptor | null;
            resolvedResource: ResourceDescriptor | null;
        };
    };
    'browse:annotation-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:events-requested': components['schemas']['BrowseEventsRequest'];
    'browse:events-result': components['schemas']['BrowseEventsResult'];
    'browse:events-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:annotation-history-requested': components['schemas']['BrowseAnnotationHistoryRequest'];
    'browse:annotation-history-result': components['schemas']['BrowseAnnotationHistoryResult'];
    'browse:annotation-history-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:annotation-context-requested': components['schemas']['BrowseAnnotationContextRequest'];
    'browse:annotation-context-result': {
        correlationId: string;
        response: Record<string, unknown>;
    };
    'browse:annotation-context-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:referenced-by-requested': components['schemas']['BrowseReferencedByRequest'];
    'browse:referenced-by-result': components['schemas']['BrowseReferencedByResult'];
    'browse:referenced-by-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:entity-types-requested': components['schemas']['BrowseEntityTypesRequest'];
    'browse:entity-types-result': components['schemas']['BrowseEntityTypesResult'];
    'browse:entity-types-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:tag-schemas-requested': components['schemas']['BrowseTagSchemasRequest'];
    'browse:tag-schemas-result': components['schemas']['BrowseTagSchemasResult'];
    'browse:tag-schemas-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:agents-requested': components['schemas']['BrowseAgentsRequest'];
    'browse:agents-result': components['schemas']['BrowseAgentsResult'];
    'browse:agents-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'browse:directory-requested': components['schemas']['BrowseDirectoryRequest'];
    'browse:directory-result': components['schemas']['BrowseDirectoryResult'];
    'browse:directory-failed': {
        correlationId: string;
        path: string;
    } & components['schemas']['CommandError'];
    'browse:click': components['schemas']['BrowseClickEvent'] & {
        anchorRect?: AnchorRect;
    };
    'browse:resource-open': components['schemas']['BrowseResourceOpenEvent'];
    'browse:resource-viewed': components['schemas']['BrowseResourceViewedEvent'];
    'browse:entity-type-clicked': components['schemas']['BrowseEntityTypeClickedEvent'];
    'panel:toggle': components['schemas']['BrowsePanelToggleEvent'];
    'panel:open': components['schemas']['BrowsePanelOpenEvent'] & {
        anchorRect?: AnchorRect;
    };
    'panel:close': void;
    'shell:sidebar-toggle': void;
    'tabs:close': components['schemas']['BrowseResourceCloseEvent'];
    'tabs:reorder': components['schemas']['BrowseResourceReorderEvent'];
    'nav:link-clicked': components['schemas']['BrowseLinkClickedEvent'];
    'nav:push': components['schemas']['BrowseRouterPushEvent'];
    'nav:external': components['schemas']['BrowseExternalNavigateEvent'] & {
        cancelFallback: () => void;
    };
    'beckon:hover': components['schemas']['BeckonHoverEvent'];
    'beckon:focus': components['schemas']['BeckonFocusEvent'];
    'beckon:sparkle': components['schemas']['BeckonSparkleEvent'];
    'job:started': StoredEvent<EventOfType<'job:started'>>;
    'job:completed': StoredEvent<EventOfType<'job:completed'>>;
    'job:failed': StoredEvent<EventOfType<'job:failed'>>;
    'job:start': components['schemas']['JobStartCommand'];
    'job:report-progress': components['schemas']['JobReportProgressCommand'];
    'job:complete': components['schemas']['JobCompleteCommand'];
    'job:fail': components['schemas']['JobFailCommand'];
    'job:checkpoint': components['schemas']['JobCheckpointCommand'];
    'job:queued': components['schemas']['JobQueuedEvent'];
    'job:cancel-requested': components['schemas']['JobCancelRequest'];
    'job:cancel': components['schemas']['JobCancelCommand'];
    'job:status-requested': components['schemas']['JobStatusRequest'];
    'job:create': components['schemas']['JobCreateCommand'];
    'job:claim': components['schemas']['JobClaimCommand'];
    'job:status-result': components['schemas']['JobStatusResult'];
    'job:status-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'job:created': components['schemas']['JobCreatedResult'];
    'job:create-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'job:claimed': {
        correlationId: string;
        response: Record<string, unknown>;
    };
    'job:claim-failed': {
        correlationId: string;
    } & components['schemas']['CommandError'];
    'job:cancel-ok': {
        correlationId?: string;
        response: {
            cancelled: number;
        };
    };
    'job:cancel-failed': components['schemas']['CommandError'];
    /**
     * Emitted by the Weaver after applying an event (or a batch's last event)
     * for a resource to the graph. `sequenceNumber` is the resource-stream
     * sequence of the last applied event. Folded by `WeaveProgress`
     * (make-meaning) into the gateway-local applied map that the
     * `whenApplied` barrier awaits. In-process signal today; crosses the
     * bus gateway after WEAVER-ISOLATION.
     */
    'weave:applied': {
        resourceId: string;
        sequenceNumber: number;
    };
    'smelt:settled': {
        resourceId: string;
        contentChecksum: string;
        outcome: 'indexed' | 'skipped';
        reason?: 'no-extractor' | 'empty' | 'no-text-layer' | 'encrypted' | 'corrupt' | 'too-large';
    };
    'weave:rebuild': components['schemas']['WeaveRebuildCommand'];
    'weave:rebuild-ok': {
        correlationId?: string;
    };
    'weave:rebuild-failed': {
        correlationId?: string;
        message: string;
    };
    'smelt:rebuild-anchors': components['schemas']['SmeltRebuildAnchorsCommand'];
    'smelt:rebuild-anchors-ok': {
        correlationId?: string;
    };
    'smelt:rebuild-anchors-failed': {
        correlationId?: string;
        message: string;
    };
    'settings:theme-changed': components['schemas']['SettingsThemeChangedEvent'];
    'settings:line-numbers-toggled': void;
    'settings:locale-changed': components['schemas']['SettingsLocaleChangedEvent'];
    'settings:hover-delay-changed': components['schemas']['SettingsHoverDelayChangedEvent'];
    'stream-connected': Record<string, never>;
    'replay-window-exceeded': {
        resourceId?: string;
        lastEventId: number;
        missedCount: number;
        cap: number;
        message: string;
    };
    /**
     * Emitted by the `/bus/subscribe` handler when a client reconnected
     * with `Last-Event-ID: p-<scope>-<seq>` but the server could not
     * replay all missed persisted events for that scope (retention
     * window exceeded, scope unknown, or request unparseable). The
     * client should treat this as a signal to fall back to the pre-
     * resumption contract: invalidate caches for the affected scope
     * and re-read from scratch. Analogous to `replay-window-exceeded`
     * but scoped to the bus gateway rather than the per-resource
     * events stream.
     *
     * `scope` is the scope string the client asked about (omitted for
     * global-persisted resumption gaps, if that path ever exists).
     * `reason` is human-readable, for logging.
     */
    'bus:resume-gap': {
        scope?: string;
        lastSeenId?: string;
        reason: string;
    };
    'session:joined': components['schemas']['SessionJoinedEvent'];
    'session:left': components['schemas']['SessionLeftEvent'];
};
export type { AnchorRect } from './bus-ui-types';
/**
 * Any valid channel name on the EventBus — `keyof EventMap`, the root channel
 * type. Two subsets matter, and confusing them is a silent-failure trap:
 *
 * - `EmittableChannel` (below) — channels with a non-null `CHANNEL_SCHEMAS`
 *   entry; what you EMIT (the `/bus/emit` gateway validates the payload).
 * - `BridgedChannel` (`bridged-channels.ts`) — the transport fan-in set; the
 *   only channels a client can SUBSCRIBE to over a concrete transport.
 *
 * Request/reply (`busRequest`) emits on an `EmittableChannel` and subscribes on
 * `BridgedChannel` replies. A reply channel that is a valid `EventName` but NOT
 * in `BRIDGED_CHANNELS` is never delivered → the request times out with no
 * compile or runtime error (see
 * `.plans/bugs/gather-resource-complete-not-bridged.md`). `busRequest` now types
 * its reply params `BridgedChannel` so that omission is a compile error.
 */
export type EventName = keyof EventMap;
/**
 * Genuine resource-bound broadcast event types.
 *
 * Publishers emit these on the scoped EventBus (`eventBus.scope(resourceId)`)
 * because every participant viewing the resource should receive them — not
 * just the caller who triggered the originating action. Examples: resource
 * generation progress, which multiple viewers of a generating resource all
 * want to see.
 *
 * Non-broadcast progress (AI-assist progress for one user, search results
 * for one caller) does NOT belong here. Those are per-caller correlation-ID
 * responses and publish globally — the caller filters by `correlationId`.
 *
 * The SDK's resource-scoped `browse.*` live queries wire these channels —
 * subscribing acquires the scope via the transport's `subscribeToResource`
 * (`scope=id&scoped=<channel>`) so the SSE route delivers them to that
 * participant (freshness follows observation; #847). WorkerStateUnit uses this
 * list to decide which emitted events to scope to their resource.
 */
export declare const RESOURCE_BROADCAST_TYPES: readonly [];
export type ResourceBroadcastType = typeof RESOURCE_BROADCAST_TYPES[number];
/**
 * Authoritative map from bus channel to OpenAPI schema name.
 *
 * Every {@link EventName} must appear. The `satisfies` clause below
 * enforces completeness at compile time — adding a channel to
 * {@link EventMap} without adding an entry here is a build error.
 *
 * Values:
 *   - `<SchemaName>`: payload validates against `components['schemas'][SchemaName]`.
 *   - `null`: no single-schema validation. Used for branded
 *     `StoredEvent` wrappers, `void` UI signals, and compound inline
 *     types (e.g. `{ correlationId } & CommandError`). These are not
 *     validated by `/bus/emit`.
 *
 * The `/bus/emit` route reads this map to validate incoming payloads.
 * Consumers can also use it to do client-side pre-flight validation
 * before emitting.
 */
export declare const CHANNEL_SCHEMAS: {
    readonly 'yield:created': null;
    readonly 'yield:cloned': null;
    readonly 'yield:updated': null;
    readonly 'yield:moved': null;
    readonly 'yield:representation-added': null;
    readonly 'yield:representation-removed': null;
    readonly 'yield:create': "YieldCreateCommand";
    readonly 'yield:clone-persist': "YieldClonePersistCommand";
    readonly 'yield:update': "YieldUpdateCommand";
    readonly 'yield:mv': "YieldMvCommand";
    readonly 'yield:clone': null;
    readonly 'yield:clone-token-requested': "YieldCloneTokenRequest";
    readonly 'yield:clone-resource-requested': "YieldCloneResourceRequest";
    readonly 'yield:clone-create': "YieldCloneCreateCommand";
    readonly 'yield:create-ok': "YieldCreateOk";
    readonly 'yield:create-failed': "CommandError";
    readonly 'yield:clone-persist-ok': "YieldClonePersistOk";
    readonly 'yield:clone-persist-failed': null;
    readonly 'yield:update-ok': "YieldUpdateOk";
    readonly 'yield:update-failed': null;
    readonly 'yield:move-failed': null;
    readonly 'yield:clone-token-generated': null;
    readonly 'yield:clone-token-failed': null;
    readonly 'yield:clone-resource-result': null;
    readonly 'yield:clone-resource-failed': null;
    readonly 'yield:clone-created': "YieldCloneCreated";
    readonly 'yield:clone-create-failed': null;
    readonly 'mark:added': null;
    readonly 'mark:removed': null;
    readonly 'mark:body-updated': null;
    readonly 'mark:entity-tag-added': null;
    readonly 'mark:entity-tag-removed': null;
    readonly 'frame:entity-type-added': null;
    readonly 'frame:tag-schema-added': null;
    readonly 'mark:archived': null;
    readonly 'mark:unarchived': null;
    readonly 'mark:create-request': "MarkCreateRequest";
    readonly 'mark:create': "MarkCreateCommand";
    readonly 'mark:delete': "MarkDeleteCommand";
    readonly 'mark:update-body': "MarkUpdateBodyCommand";
    readonly 'mark:archive': "MarkArchiveCommand";
    readonly 'mark:unarchive': "MarkUnarchiveCommand";
    readonly 'mark:update-entity-types': "MarkUpdateEntityTypesCommand";
    readonly 'frame:add-entity-type': "FrameAddEntityTypeCommand";
    readonly 'frame:add-tag-schema': "FrameAddTagSchemaCommand";
    readonly 'mark:create-ok': "MarkCreateOk";
    readonly 'mark:create-failed': "CommandError";
    readonly 'mark:commit': "MarkCommitCommand";
    readonly 'mark:commit-ok': "MarkCommitOk";
    readonly 'mark:commit-failed': "CommandError";
    readonly 'mark:delete-ok': "MarkDeleteOk";
    readonly 'mark:delete-failed': "CommandError";
    readonly 'mark:archive-ok': null;
    readonly 'mark:archive-failed': "CommandError";
    readonly 'mark:unarchive-ok': null;
    readonly 'mark:unarchive-failed': "CommandError";
    readonly 'mark:update-entity-types-ok': null;
    readonly 'mark:update-entity-types-failed': "CommandError";
    readonly 'mark:body-update-failed': "CommandError";
    readonly 'frame:entity-type-add-ok': null;
    readonly 'frame:entity-type-add-failed': "CommandError";
    readonly 'frame:tag-schema-add-ok': null;
    readonly 'frame:tag-schema-add-failed': "CommandError";
    readonly 'mark:select-comment': "SelectionData";
    readonly 'mark:select-tag': "SelectionData";
    readonly 'mark:select-assessment': "SelectionData";
    readonly 'mark:select-reference': "SelectionData";
    readonly 'mark:requested': "MarkRequestedEvent";
    readonly 'mark:cancel-pending': null;
    readonly 'mark:submit': "MarkSubmitEvent";
    readonly 'mark:assist-request': "MarkAssistRequestEvent";
    readonly 'mark:progress-dismiss': null;
    readonly 'mark:assist-timeout': null;
    readonly 'mark:create-error': null;
    readonly 'mark:delete-error': null;
    readonly 'bind:body-error': null;
    readonly 'bind:initiate': "BindInitiateCommand";
    readonly 'bind:update-body': "BindUpdateBodyCommand";
    readonly 'bind:body-updated': "BindBodyUpdated";
    readonly 'bind:body-update-failed': "CommandError";
    readonly 'match:search-requested': "MatchSearchRequest";
    readonly 'match:search-results': "MatchSearchResult";
    readonly 'match:search-failed': "MatchSearchFailed";
    readonly 'gather:requested': "GatherAnnotationRequest";
    readonly 'gather:complete': "GatherAnnotationComplete";
    readonly 'gather:failed': null;
    readonly 'gather:resource-requested': "GatherResourceRequest";
    readonly 'gather:resource-complete': "GatherResourceComplete";
    readonly 'gather:resource-failed': null;
    readonly 'gather:summary-requested': "GatherSummaryRequest";
    readonly 'gather:summary-result': null;
    readonly 'gather:summary-failed': null;
    readonly 'gather:annotation-progress': "GatherProgress";
    readonly 'browse:resource-requested': "BrowseResourceRequest";
    readonly 'browse:resource-result': "BrowseResourceResult";
    readonly 'browse:resource-failed': null;
    readonly 'browse:anchored-text-requested': "BrowseAnchoredTextRequest";
    readonly 'browse:anchored-text-result': "BrowseAnchoredTextResult";
    readonly 'browse:anchored-text-failed': null;
    readonly 'browse:resources-requested': "BrowseResourcesRequest";
    readonly 'browse:resources-result': "BrowseResourcesResult";
    readonly 'browse:resources-failed': null;
    readonly 'browse:annotations-requested': "BrowseAnnotationsRequest";
    readonly 'browse:annotations-result': "BrowseAnnotationsResult";
    readonly 'browse:annotations-failed': null;
    readonly 'browse:annotation-requested': "BrowseAnnotationRequest";
    readonly 'browse:annotation-result': "BrowseAnnotationResult";
    readonly 'browse:annotation-failed': null;
    readonly 'browse:events-requested': "BrowseEventsRequest";
    readonly 'browse:events-result': "BrowseEventsResult";
    readonly 'browse:events-failed': null;
    readonly 'browse:annotation-history-requested': "BrowseAnnotationHistoryRequest";
    readonly 'browse:annotation-history-result': "BrowseAnnotationHistoryResult";
    readonly 'browse:annotation-history-failed': null;
    readonly 'browse:annotation-context-requested': "BrowseAnnotationContextRequest";
    readonly 'browse:annotation-context-result': null;
    readonly 'browse:annotation-context-failed': null;
    readonly 'browse:referenced-by-requested': "BrowseReferencedByRequest";
    readonly 'browse:referenced-by-result': "BrowseReferencedByResult";
    readonly 'browse:referenced-by-failed': null;
    readonly 'browse:entity-types-requested': "BrowseEntityTypesRequest";
    readonly 'browse:entity-types-result': "BrowseEntityTypesResult";
    readonly 'browse:entity-types-failed': null;
    readonly 'browse:tag-schemas-requested': "BrowseTagSchemasRequest";
    readonly 'browse:tag-schemas-result': "BrowseTagSchemasResult";
    readonly 'browse:tag-schemas-failed': null;
    readonly 'browse:agents-requested': "BrowseAgentsRequest";
    readonly 'browse:agents-result': "BrowseAgentsResult";
    readonly 'browse:agents-failed': null;
    readonly 'browse:directory-requested': "BrowseDirectoryRequest";
    readonly 'browse:directory-result': "BrowseDirectoryResult";
    readonly 'browse:directory-failed': null;
    readonly 'browse:click': "BrowseClickEvent";
    readonly 'browse:resource-open': "BrowseResourceOpenEvent";
    readonly 'browse:resource-viewed': "BrowseResourceViewedEvent";
    readonly 'browse:entity-type-clicked': "BrowseEntityTypeClickedEvent";
    readonly 'panel:toggle': "BrowsePanelToggleEvent";
    readonly 'panel:open': null;
    readonly 'panel:close': null;
    readonly 'shell:sidebar-toggle': null;
    readonly 'tabs:close': "BrowseResourceCloseEvent";
    readonly 'tabs:reorder': "BrowseResourceReorderEvent";
    readonly 'nav:link-clicked': "BrowseLinkClickedEvent";
    readonly 'nav:push': "BrowseRouterPushEvent";
    readonly 'nav:external': null;
    readonly 'beckon:hover': "BeckonHoverEvent";
    readonly 'beckon:focus': "BeckonFocusEvent";
    readonly 'beckon:sparkle': "BeckonSparkleEvent";
    readonly 'job:started': null;
    readonly 'job:completed': null;
    readonly 'job:failed': null;
    readonly 'job:start': "JobStartCommand";
    readonly 'job:report-progress': "JobReportProgressCommand";
    readonly 'job:complete': "JobCompleteCommand";
    readonly 'job:fail': "JobFailCommand";
    readonly 'job:checkpoint': "JobCheckpointCommand";
    readonly 'job:queued': "JobQueuedEvent";
    readonly 'job:cancel-requested': "JobCancelRequest";
    readonly 'job:cancel': "JobCancelCommand";
    readonly 'job:status-requested': "JobStatusRequest";
    readonly 'job:create': "JobCreateCommand";
    readonly 'job:claim': "JobClaimCommand";
    readonly 'job:status-result': "JobStatusResult";
    readonly 'job:status-failed': null;
    readonly 'job:created': "JobCreatedResult";
    readonly 'job:create-failed': null;
    readonly 'job:claimed': null;
    readonly 'job:claim-failed': null;
    readonly 'job:cancel-ok': null;
    readonly 'job:cancel-failed': "CommandError";
    readonly 'settings:theme-changed': "SettingsThemeChangedEvent";
    readonly 'settings:line-numbers-toggled': null;
    readonly 'settings:locale-changed': "SettingsLocaleChangedEvent";
    readonly 'settings:hover-delay-changed': "SettingsHoverDelayChangedEvent";
    readonly 'weave:applied': null;
    readonly 'smelt:settled': null;
    readonly 'weave:rebuild': "WeaveRebuildCommand";
    readonly 'weave:rebuild-ok': null;
    readonly 'weave:rebuild-failed': null;
    readonly 'smelt:rebuild-anchors': "SmeltRebuildAnchorsCommand";
    readonly 'smelt:rebuild-anchors-ok': null;
    readonly 'smelt:rebuild-anchors-failed': null;
    readonly 'stream-connected': null;
    readonly 'replay-window-exceeded': null;
    readonly 'bus:resume-gap': null;
    readonly 'session:joined': "SessionJoinedEvent";
    readonly 'session:left': "SessionLeftEvent";
};
/** Channels where `/bus/emit` validates the payload (non-null schema). */
export type EmittableChannel = {
    [K in EventName]: typeof CHANNEL_SCHEMAS[K] extends null ? never : K;
}[EventName];
