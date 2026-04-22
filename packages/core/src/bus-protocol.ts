/**
 * Bus Protocol
 *
 * The complete EventMap for the RxJS EventBus. Every channel name and
 * its payload type is defined here — domain events, commands, reads,
 * results, SSE stream payloads, and frontend UI events.
 *
 * Command and result payloads use OpenAPI-generated types (plain strings
 * for identifiers). Branded type safety (ResourceId, UserId, etc.) is
 * enforced at function boundaries, not on bus payloads — callers use
 * factory functions (resourceId(), userId()) at the consume boundary.
 *
 * Domain events (StoredEvent<Interface>) retain branded types as they
 * are the system of record, not wire-format payloads.
 *
 * Organized by flow (verb), then by category within each flow.
 */

import type { components } from './types';
import type { StoredEvent } from './event-base';
import type { EventOfType } from './persisted-events';

/**
 * The unified EventMap — every channel on the EventBus.
 *
 * Convention:
 * - Domain events (past tense): StoredEvent<Interface> — branded types
 * - Commands/reads/results/UI: OpenAPI schema refs — plain strings
 * - void: UI-only signals with no payload
 */
export type EventMap = {

  // ========================================================================
  // YIELD FLOW — resource creation, update, move, clone
  // ========================================================================

  // Domain events (branded — system of record)
  'yield:created': StoredEvent<EventOfType<'yield:created'>>;
  'yield:cloned': StoredEvent<EventOfType<'yield:cloned'>>;
  'yield:updated': StoredEvent<EventOfType<'yield:updated'>>;
  'yield:moved': StoredEvent<EventOfType<'yield:moved'>>;
  'yield:representation-added': StoredEvent<EventOfType<'yield:representation-added'>>;
  'yield:representation-removed': StoredEvent<EventOfType<'yield:representation-removed'>>;

  // Generation lifecycle flows through the unified job:* family
  // (job:start, job:report-progress, job:complete, job:fail). The
  // pre-unification `yield:progress`/`yield:finished`/`yield:failed`
  // channels were removed on the lifecycle-unification.

  // Commands
  'yield:request': components['schemas']['YieldRequestCommand'];
  'yield:create': components['schemas']['YieldCreateCommand'];
  'yield:update': components['schemas']['YieldUpdateCommand'];
  'yield:mv': components['schemas']['YieldMvCommand'];
  'yield:clone': void;
  'yield:clone-token-requested': components['schemas']['YieldCloneTokenRequest'];
  'yield:clone-resource-requested': components['schemas']['YieldCloneResourceRequest'];
  'yield:clone-create': components['schemas']['YieldCloneCreateCommand'];

  // Command results
  'yield:create-ok': components['schemas']['YieldCreateOk'];
  'yield:create-failed': components['schemas']['CommandError'];
  'yield:update-ok': components['schemas']['YieldUpdateOk'];
  'yield:update-failed': components['schemas']['YieldUpdateOk'] & components['schemas']['CommandError'];
  'yield:move-ok': components['schemas']['YieldMoveOk'];
  'yield:move-failed': { fromUri: string } & components['schemas']['CommandError'];
  'yield:clone-token-generated': { correlationId: string; response: components['schemas']['CloneResourceWithTokenResponse'] };
  'yield:clone-token-failed': { correlationId: string } & components['schemas']['CommandError'];
  'yield:clone-resource-result': { correlationId: string; response: components['schemas']['GetResourceByTokenResponse'] };
  'yield:clone-resource-failed': { correlationId: string } & components['schemas']['CommandError'];
  'yield:clone-created': components['schemas']['YieldCloneCreated'];
  'yield:clone-create-failed': { correlationId: string } & components['schemas']['CommandError'];

  // ========================================================================
  // MARK FLOW — annotation CRUD, entity types, AI assist
  // ========================================================================

  // Domain events (branded — system of record)
  'mark:added': StoredEvent<EventOfType<'mark:added'>>;
  'mark:removed': StoredEvent<EventOfType<'mark:removed'>>;
  'mark:body-updated': StoredEvent<EventOfType<'mark:body-updated'>>;
  'mark:entity-tag-added': StoredEvent<EventOfType<'mark:entity-tag-added'>>;
  'mark:entity-tag-removed': StoredEvent<EventOfType<'mark:entity-tag-removed'>>;
  'mark:entity-type-added': StoredEvent<EventOfType<'mark:entity-type-added'>>;
  'mark:archived': StoredEvent<EventOfType<'mark:archived'>>;
  'mark:unarchived': StoredEvent<EventOfType<'mark:unarchived'>>;

  // Annotation-job lifecycle flows through the unified job:* family
  // (job:start, job:report-progress, job:complete, job:fail). UI
  // consumers filter by jobType. The pre-unification channels
  // `mark:progress`/`mark:assist-finished`/`mark:assist-failed` were
  // removed on the lifecycle-unification.

  // Commands
  'mark:create-request': components['schemas']['MarkCreateRequest'];
  'mark:create': components['schemas']['MarkCreateCommand'];
  'mark:delete': components['schemas']['MarkDeleteCommand'];
  'mark:update-body': components['schemas']['MarkUpdateBodyCommand'];
  'mark:archive': components['schemas']['MarkArchiveCommand'];
  'mark:unarchive': components['schemas']['MarkUnarchiveCommand'];
  'mark:update-entity-types': components['schemas']['MarkUpdateEntityTypesCommand'];
  'mark:add-entity-type': components['schemas']['MarkAddEntityTypeCommand'];

  // Command results
  'mark:create-ok': components['schemas']['MarkCreateOk'];
  'mark:create-failed': components['schemas']['CommandError'];
  'mark:delete-ok': components['schemas']['MarkDeleteOk'];
  'mark:delete-failed': components['schemas']['CommandError'];
  'mark:body-update-failed': components['schemas']['CommandError'];
  'mark:entity-type-add-failed': components['schemas']['CommandError'];

  // UI events
  'mark:select-comment': components['schemas']['SelectionData'];
  'mark:select-tag': components['schemas']['SelectionData'];
  'mark:select-assessment': components['schemas']['SelectionData'];
  'mark:select-reference': components['schemas']['SelectionData'];
  'mark:requested': components['schemas']['MarkRequestedEvent'];
  'mark:cancel-pending': void;
  'mark:submit': components['schemas']['MarkSubmitEvent'];
  'mark:assist-request': components['schemas']['MarkAssistRequestEvent'];
  'mark:assist-cancelled': void;
  'mark:progress-dismiss': void;
  'mark:mode-toggled': void;
  'mark:selection-changed': components['schemas']['MarkSelectionChangedEvent'];
  'mark:click-changed': components['schemas']['MarkClickChangedEvent'];
  'mark:shape-changed': components['schemas']['MarkShapeChangedEvent'];

  // ========================================================================
  // BIND FLOW — reference linking
  // ========================================================================

  'bind:initiate': components['schemas']['BindInitiateCommand'];
  'bind:update-body': components['schemas']['BindUpdateBodyCommand'];
  'bind:body-updated': components['schemas']['BindBodyUpdated'];
  'bind:body-update-failed': components['schemas']['CommandError'];

  // ========================================================================
  // MATCH FLOW — search
  // ========================================================================

  'match:search-requested': components['schemas']['MatchSearchRequest'];
  'match:search-results': components['schemas']['MatchSearchResult'];
  'match:search-failed': components['schemas']['MatchSearchFailed'];

  // ========================================================================
  // GATHER FLOW — context gathering
  // ========================================================================

  'gather:requested': components['schemas']['GatherAnnotationRequest'];
  'gather:complete': components['schemas']['GatherAnnotationComplete'];
  'gather:failed': { correlationId: string; annotationId: string } & components['schemas']['CommandError'];
  'gather:resource-requested': components['schemas']['GatherResourceRequest'];
  'gather:resource-complete': components['schemas']['GatherResourceComplete'];
  'gather:resource-failed': { correlationId: string; resourceId: string } & components['schemas']['CommandError'];

  'gather:summary-requested': components['schemas']['GatherSummaryRequest'];
  'gather:summary-result': { correlationId: string; response: Record<string, unknown> };
  'gather:summary-failed': { correlationId: string } & components['schemas']['CommandError'];

  // SSE stream payloads
  'gather:annotation-progress': components['schemas']['GatherProgress'];
  'gather:annotation-finished': components['schemas']['GatherAnnotationFinished'];
  'gather:progress': components['schemas']['GatherProgress'];
  'gather:finished': components['schemas']['GatherFinished'];

  // ========================================================================
  // BROWSE FLOW — knowledge base reads + UI navigation
  // ========================================================================

  // Reads
  'browse:resource-requested': components['schemas']['BrowseResourceRequest'];
  'browse:resource-result': components['schemas']['BrowseResourceResult'];
  'browse:resource-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:resources-requested': components['schemas']['BrowseResourcesRequest'];
  'browse:resources-result': components['schemas']['BrowseResourcesResult'];
  'browse:resources-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:annotations-requested': components['schemas']['BrowseAnnotationsRequest'];
  'browse:annotations-result': components['schemas']['BrowseAnnotationsResult'];
  'browse:annotations-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:annotation-requested': components['schemas']['BrowseAnnotationRequest'];
  'browse:annotation-result': components['schemas']['BrowseAnnotationResult'];
  'browse:annotation-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:events-requested': components['schemas']['BrowseEventsRequest'];
  'browse:events-result': components['schemas']['BrowseEventsResult'];
  'browse:events-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:annotation-history-requested': components['schemas']['BrowseAnnotationHistoryRequest'];
  'browse:annotation-history-result': components['schemas']['BrowseAnnotationHistoryResult'];
  'browse:annotation-history-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:annotation-context-requested': components['schemas']['BrowseAnnotationContextRequest'];
  'browse:annotation-context-result': { correlationId: string; response: Record<string, unknown> };
  'browse:annotation-context-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:referenced-by-requested': components['schemas']['BrowseReferencedByRequest'];
  'browse:referenced-by-result': components['schemas']['BrowseReferencedByResult'];
  'browse:referenced-by-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:entity-types-requested': components['schemas']['BrowseEntityTypesRequest'];
  'browse:entity-types-result': components['schemas']['BrowseEntityTypesResult'];
  'browse:entity-types-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:directory-requested': components['schemas']['BrowseDirectoryRequest'];
  'browse:directory-result': components['schemas']['BrowseDirectoryResult'];
  'browse:directory-failed': { correlationId: string; path: string } & components['schemas']['CommandError'];

  // UI events (session-scoped — fire on the client bus, tied to a KB)
  'browse:click': components['schemas']['BrowseClickEvent'];
  'browse:reference-navigate': components['schemas']['BrowseReferenceNavigateEvent'];
  'browse:entity-type-clicked': components['schemas']['BrowseEntityTypeClickedEvent'];

  // ========================================================================
  // SHELL — app-scoped UI events (fire on SemiontBrowser's bus, not the
  // per-session client bus). These must work regardless of whether a
  // KB session is active: panel toggles, sidebar, tab bar, routing.
  // ========================================================================

  'panel:toggle': components['schemas']['BrowsePanelToggleEvent'];
  'panel:open': components['schemas']['BrowsePanelOpenEvent'];
  'panel:close': void;
  'shell:sidebar-toggle': void;
  'tabs:close': components['schemas']['BrowseResourceCloseEvent'];
  'tabs:reorder': components['schemas']['BrowseResourceReorderEvent'];
  'nav:link-clicked': components['schemas']['BrowseLinkClickedEvent'];
  'nav:push': components['schemas']['BrowseRouterPushEvent'];
  'nav:external': components['schemas']['BrowseExternalNavigateEvent'] & { cancelFallback: () => void };

  // ========================================================================
  // BECKON FLOW — annotation attention
  // ========================================================================

  'beckon:hover': components['schemas']['BeckonHoverEvent'];
  'beckon:focus': components['schemas']['BeckonFocusEvent'];
  'beckon:sparkle': components['schemas']['BeckonSparkleEvent'];

  // ========================================================================
  // JOB FLOW — worker commands + domain events
  // ========================================================================

  // Domain events (branded — system of record)
  'job:started': StoredEvent<EventOfType<'job:started'>>;
  'job:progress': StoredEvent<EventOfType<'job:progress'>>;
  'job:completed': StoredEvent<EventOfType<'job:completed'>>;
  'job:failed': StoredEvent<EventOfType<'job:failed'>>;

  // Commands
  'job:start': components['schemas']['JobStartCommand'];
  'job:report-progress': components['schemas']['JobReportProgressCommand'];
  'job:complete': components['schemas']['JobCompleteCommand'];
  'job:fail': components['schemas']['JobFailCommand'];
  'job:queued': components['schemas']['JobQueuedEvent'];
  'job:cancel-requested': components['schemas']['JobCancelRequest'];
  'job:status-requested': components['schemas']['JobStatusRequest'];
  'job:create': components['schemas']['JobCreateCommand'];
  'job:claim': components['schemas']['JobClaimCommand'];

  // Results
  'job:status-result': components['schemas']['JobStatusResult'];
  'job:status-failed': { correlationId: string } & components['schemas']['CommandError'];
  'job:created': components['schemas']['JobCreatedResult'];
  'job:create-failed': { correlationId: string } & components['schemas']['CommandError'];
  'job:claimed': { correlationId: string; response: Record<string, unknown> };
  'job:claim-failed': { correlationId: string } & components['schemas']['CommandError'];

  // ========================================================================
  // SETTINGS (frontend-only)
  // ========================================================================

  'settings:theme-changed': components['schemas']['SettingsThemeChangedEvent'];
  'settings:line-numbers-toggled': void;
  'settings:locale-changed': components['schemas']['SettingsLocaleChangedEvent'];
  'settings:hover-delay-changed': components['schemas']['SettingsHoverDelayChangedEvent'];

  // ========================================================================
  // SSE infrastructure
  // ========================================================================

  'stream-connected': Record<string, never>;
  'replay-window-exceeded': { resourceId?: string; lastEventId: number; missedCount: number; cap: number; message: string };
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
  'bus:resume-gap': { scope?: string; lastSeenId?: string; reason: string };
};

/** Any valid channel name on the EventBus. */
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
 * The frontend's `subscribeToResource(id)` wires these channels via
 * `scope=id&scoped=<channel>` so the SSE route delivers them to that
 * participant. WorkerVM uses this list to decide which emitted events to
 * scope to their resource.
 */
/**
 * Audit note (SIMPLE-BUS Phase 3 close): `yield:progress` was
 * considered for inclusion but has only one consumer — the
 * yield-initiator's Observable in `packages/api-client/src/namespaces/yield.ts`.
 * No viewer of the resource other than the initiator subscribes to
 * progress. Scoping therefore serves no fan-out-narrowing purpose for
 * that channel, so it stays global (as a correlation-ID-shaped
 * response, filtered by `referenceId`). Only `yield:finished` and
 * `yield:failed` have a genuine multi-participant consumer (the
 * ResourceViewerPage toast on the source resource).
 */
export const RESOURCE_BROADCAST_TYPES = [
  // Post-unification: job:complete / job:fail carry the "job ended on
  // this resource" signal that yield:finished / yield:failed used to.
  // Scope them by resource so every viewer of the affected resource
  // — not just the initiator — can react (toast, refresh, etc.).
  'job:complete',
  'job:fail',
] as const satisfies readonly EventName[];

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
export const CHANNEL_SCHEMAS = {
  // ── YIELD FLOW ──────────────────────────────────────────────────
  'yield:created':                    null, // StoredEvent
  'yield:cloned':                     null,
  'yield:updated':                    null,
  'yield:moved':                      null,
  'yield:representation-added':       null,
  'yield:representation-removed':     null,
  'yield:request':                    'YieldRequestCommand',
  'yield:create':                     'YieldCreateCommand',
  'yield:update':                     'YieldUpdateCommand',
  'yield:mv':                         'YieldMvCommand',
  'yield:clone':                      null, // void
  'yield:clone-token-requested':      'YieldCloneTokenRequest',
  'yield:clone-resource-requested':   'YieldCloneResourceRequest',
  'yield:clone-create':               'YieldCloneCreateCommand',
  'yield:create-ok':                  'YieldCreateOk',
  'yield:create-failed':              'CommandError',
  'yield:update-ok':                  'YieldUpdateOk',
  'yield:update-failed':              null, // YieldUpdateOk & CommandError
  'yield:move-ok':                    'YieldMoveOk',
  'yield:move-failed':                null, // { fromUri } & CommandError
  'yield:clone-token-generated':      null, // { correlationId; response: CloneResourceWithTokenResponse }
  'yield:clone-token-failed':         null, // { correlationId } & CommandError
  'yield:clone-resource-result':      null, // { correlationId; response: GetResourceByTokenResponse }
  'yield:clone-resource-failed':      null, // { correlationId } & CommandError
  'yield:clone-created':              'YieldCloneCreated',
  'yield:clone-create-failed':        null, // { correlationId } & CommandError

  // ── MARK FLOW ───────────────────────────────────────────────────
  'mark:added':                       null, // StoredEvent
  'mark:removed':                     null,
  'mark:body-updated':                null,
  'mark:entity-tag-added':            null,
  'mark:entity-tag-removed':          null,
  'mark:entity-type-added':           null,
  'mark:archived':                    null,
  'mark:unarchived':                  null,
  'mark:create-request':              'MarkCreateRequest',
  'mark:create':                      'MarkCreateCommand',
  'mark:delete':                      'MarkDeleteCommand',
  'mark:update-body':                 'MarkUpdateBodyCommand',
  'mark:archive':                     'MarkArchiveCommand',
  'mark:unarchive':                   'MarkUnarchiveCommand',
  'mark:update-entity-types':         'MarkUpdateEntityTypesCommand',
  'mark:add-entity-type':             'MarkAddEntityTypeCommand',
  'mark:create-ok':                   'MarkCreateOk',
  'mark:create-failed':               'CommandError',
  'mark:delete-ok':                   'MarkDeleteOk',
  'mark:delete-failed':               'CommandError',
  'mark:body-update-failed':          'CommandError',
  'mark:entity-type-add-failed':      'CommandError',
  'mark:select-comment':              'SelectionData',
  'mark:select-tag':                  'SelectionData',
  'mark:select-assessment':           'SelectionData',
  'mark:select-reference':            'SelectionData',
  'mark:requested':                   'MarkRequestedEvent',
  'mark:cancel-pending':              null, // void
  'mark:submit':                      'MarkSubmitEvent',
  'mark:assist-request':              'MarkAssistRequestEvent',
  'mark:assist-cancelled':            null, // void
  'mark:progress-dismiss':            null, // void
  'mark:mode-toggled':                null, // void
  'mark:selection-changed':           'MarkSelectionChangedEvent',
  'mark:click-changed':               'MarkClickChangedEvent',
  'mark:shape-changed':               'MarkShapeChangedEvent',

  // ── BIND FLOW ───────────────────────────────────────────────────
  'bind:initiate':                    'BindInitiateCommand',
  'bind:update-body':                 'BindUpdateBodyCommand',
  'bind:body-updated':                'BindBodyUpdated',
  'bind:body-update-failed':          'CommandError',

  // ── MATCH FLOW ──────────────────────────────────────────────────
  'match:search-requested':           'MatchSearchRequest',
  'match:search-results':             'MatchSearchResult',
  'match:search-failed':              'MatchSearchFailed',

  // ── GATHER FLOW ─────────────────────────────────────────────────
  'gather:requested':                 'GatherAnnotationRequest',
  'gather:complete':                  'GatherAnnotationComplete',
  'gather:failed':                    null, // { correlationId; annotationId } & CommandError
  'gather:resource-requested':        'GatherResourceRequest',
  'gather:resource-complete':         'GatherResourceComplete',
  'gather:resource-failed':           null, // { correlationId; resourceId } & CommandError
  'gather:summary-requested':         'GatherSummaryRequest',
  'gather:summary-result':            null, // { correlationId; response: Record<string, unknown> }
  'gather:summary-failed':            null, // { correlationId } & CommandError
  'gather:annotation-progress':       'GatherProgress',
  'gather:annotation-finished':       'GatherAnnotationFinished',
  'gather:progress':                  'GatherProgress',
  'gather:finished':                  'GatherFinished',

  // ── BROWSE FLOW ─────────────────────────────────────────────────
  'browse:resource-requested':        'BrowseResourceRequest',
  'browse:resource-result':           'BrowseResourceResult',
  'browse:resource-failed':           null, // { correlationId } & CommandError
  'browse:resources-requested':       'BrowseResourcesRequest',
  'browse:resources-result':          'BrowseResourcesResult',
  'browse:resources-failed':          null,
  'browse:annotations-requested':     'BrowseAnnotationsRequest',
  'browse:annotations-result':        'BrowseAnnotationsResult',
  'browse:annotations-failed':        null,
  'browse:annotation-requested':      'BrowseAnnotationRequest',
  'browse:annotation-result':         'BrowseAnnotationResult',
  'browse:annotation-failed':         null,
  'browse:events-requested':          'BrowseEventsRequest',
  'browse:events-result':             'BrowseEventsResult',
  'browse:events-failed':             null,
  'browse:annotation-history-requested': 'BrowseAnnotationHistoryRequest',
  'browse:annotation-history-result': 'BrowseAnnotationHistoryResult',
  'browse:annotation-history-failed': null,
  'browse:annotation-context-requested': 'BrowseAnnotationContextRequest',
  'browse:annotation-context-result': null, // { correlationId; response: Record<string, unknown> }
  'browse:annotation-context-failed': null,
  'browse:referenced-by-requested':   'BrowseReferencedByRequest',
  'browse:referenced-by-result':      'BrowseReferencedByResult',
  'browse:referenced-by-failed':      null,
  'browse:entity-types-requested':    'BrowseEntityTypesRequest',
  'browse:entity-types-result':       'BrowseEntityTypesResult',
  'browse:entity-types-failed':       null,
  'browse:directory-requested':       'BrowseDirectoryRequest',
  'browse:directory-result':          'BrowseDirectoryResult',
  'browse:directory-failed':          null, // { correlationId; path } & CommandError
  'browse:click':                     'BrowseClickEvent',
  'browse:reference-navigate':        'BrowseReferenceNavigateEvent',
  'browse:entity-type-clicked':       'BrowseEntityTypeClickedEvent',

  // ── SHELL (app-scoped UI events, fire on SemiontBrowser bus) ────
  'panel:toggle':                     'BrowsePanelToggleEvent',
  'panel:open':                       'BrowsePanelOpenEvent',
  'panel:close':                      null, // void
  'shell:sidebar-toggle':             null, // void
  'tabs:close':                       'BrowseResourceCloseEvent',
  'tabs:reorder':                     'BrowseResourceReorderEvent',
  'nav:link-clicked':                 'BrowseLinkClickedEvent',
  'nav:push':                         'BrowseRouterPushEvent',
  'nav:external':                     null, // includes runtime `cancelFallback: () => void`

  // ── BECKON FLOW ─────────────────────────────────────────────────
  'beckon:hover':                     'BeckonHoverEvent',
  'beckon:focus':                     'BeckonFocusEvent',
  'beckon:sparkle':                   'BeckonSparkleEvent',

  // ── JOB FLOW ────────────────────────────────────────────────────
  'job:started':                      null, // StoredEvent
  'job:progress':                     null,
  'job:completed':                    null,
  'job:failed':                       null,
  'job:start':                        'JobStartCommand',
  'job:report-progress':              'JobReportProgressCommand',
  'job:complete':                     'JobCompleteCommand',
  'job:fail':                         'JobFailCommand',
  'job:queued':                       'JobQueuedEvent',
  'job:cancel-requested':             'JobCancelRequest',
  'job:status-requested':             'JobStatusRequest',
  'job:create':                       'JobCreateCommand',
  'job:claim':                        'JobClaimCommand',
  'job:status-result':                'JobStatusResult',
  'job:status-failed':                null, // { correlationId } & CommandError
  'job:created':                      'JobCreatedResult',
  'job:create-failed':                null,
  'job:claimed':                      null, // { correlationId; response: Record<string, unknown> }
  'job:claim-failed':                 null,

  // ── SETTINGS (frontend-only) ────────────────────────────────────
  'settings:theme-changed':           'SettingsThemeChangedEvent',
  'settings:line-numbers-toggled':    null, // void
  'settings:locale-changed':          'SettingsLocaleChangedEvent',
  'settings:hover-delay-changed':     'SettingsHoverDelayChangedEvent',

  // ── SSE infrastructure ──────────────────────────────────────────
  'stream-connected':                 null, // Record<string, never>
  'replay-window-exceeded':           null, // inline payload
  'bus:resume-gap':                   null, // inline payload
} as const satisfies Record<EventName, keyof components['schemas'] | null>;

/** Channels where `/bus/emit` validates the payload (non-null schema). */
export type EmittableChannel = {
  [K in EventName]: typeof CHANNEL_SCHEMAS[K] extends null ? never : K
}[EventName];
