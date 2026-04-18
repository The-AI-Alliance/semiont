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

// ── Shared type aliases (re-exported for convenience) ────────────────────────

export type Selector =
  | components['schemas']['TextPositionSelector']
  | components['schemas']['TextQuoteSelector']
  | components['schemas']['SvgSelector']
  | components['schemas']['FragmentSelector'];

export type GatheredContext = components['schemas']['GatheredContext'];
export type YieldProgress = components['schemas']['YieldProgress'];
export type MarkProgress = components['schemas']['MarkProgress'];
export type SelectionData = components['schemas']['SelectionData'];

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

  // SSE stream payloads
  'yield:progress': components['schemas']['YieldProgress'];
  'yield:finished': components['schemas']['YieldProgress'];
  'yield:failed': components['schemas']['YieldStreamError'];

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

  // SSE stream payloads
  'mark:progress': components['schemas']['MarkProgress'];
  'mark:assist-finished': components['schemas']['MarkAssistFinished'];
  'mark:assist-failed': components['schemas']['MarkAssistFailed'];

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

  // UI events
  'browse:click': components['schemas']['BrowseClickEvent'];
  'browse:panel-toggle': components['schemas']['BrowsePanelToggleEvent'];
  'browse:panel-open': components['schemas']['BrowsePanelOpenEvent'];
  'browse:panel-close': void;
  'browse:sidebar-toggle': void;
  'browse:resource-close': components['schemas']['BrowseResourceCloseEvent'];
  'browse:resource-reorder': components['schemas']['BrowseResourceReorderEvent'];
  'browse:link-clicked': components['schemas']['BrowseLinkClickedEvent'];
  'browse:router-push': components['schemas']['BrowseRouterPushEvent'];
  'browse:external-navigate': components['schemas']['BrowseExternalNavigateEvent'] & { cancelFallback: () => void };
  'browse:reference-navigate': components['schemas']['BrowseReferenceNavigateEvent'];
  'browse:entity-type-clicked': components['schemas']['BrowseEntityTypeClickedEvent'];

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
};

/** Any valid channel name on the EventBus. */
export type EventName = keyof EventMap;

/**
 * Non-persisted event types that the per-resource events-stream should deliver
 * to all connected clients. These are ephemeral command-result and progress
 * events that don't go through EventStore.appendEvent but still need to reach
 * every participant viewing the resource for real-time collaboration.
 *
 * Actors (Binder, Gatherer, workers) publish these on the scoped EventBus
 * (`eventBus.scope(resourceId)`). The events-stream route subscribes to them
 * alongside the persisted event types.
 *
 * Unlike PERSISTED_EVENT_TYPES, there's no compile-time exhaustiveness check
 * here because these event types are a curated subset of EventMap — not every
 * non-persisted event should flow to all participants. Adding a new one is a
 * deliberate choice, not an automatic cascade.
 */
export const STREAM_COMMAND_RESULT_TYPES = [
  // Match flow — search results for binding candidates
  'match:search-results',
  'match:search-failed',
  // Gather flow — assembled context for reference resolution
  'gather:complete',
  'gather:failed',
  'gather:annotation-progress',
  // Mark flow — AI-assisted annotation progress
  'mark:progress',
  'mark:assist-finished',
  'mark:assist-failed',
  // Yield flow — resource generation progress
  'yield:progress',
  'yield:finished',
  'yield:failed',
] as const satisfies readonly EventName[];
