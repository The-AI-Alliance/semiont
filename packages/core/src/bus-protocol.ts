/**
 * Bus Protocol
 *
 * The complete EventMap for the RxJS EventBus. Every channel name and
 * its payload type is defined here — domain events, commands, reads,
 * results, SSE stream payloads, and frontend UI events.
 *
 * Organized by flow (verb), then by category within each flow.
 * This is the single file that answers "what can travel on the bus?"
 */

import type { components } from './types';
import type { ResourceId, AnnotationId, UserId } from './identifiers';
import type { JobId } from './branded-types';
import type { CreationMethod } from './creation-methods';
import type { BodyOperation, StoredEvent } from './event-base';
import type {
  ResourceCreatedEvent, ResourceClonedEvent, ResourceUpdatedEvent, ResourceMovedEvent,
  RepresentationAddedEvent, RepresentationRemovedEvent,
  AnnotationAddedEvent, AnnotationRemovedEvent, AnnotationBodyUpdatedEvent,
  ResourceArchivedEvent, ResourceUnarchivedEvent,
  EntityTagAddedEvent, EntityTagRemovedEvent, EntityTypeAddedEvent,
  JobStartedEvent, JobProgressEvent, JobCompletedEvent, JobFailedEvent,
} from './event-catalog';

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

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

/**
 * The unified EventMap — every channel on the EventBus.
 *
 * Convention:
 * - Domain events (past tense): StoredEvent<Interface>
 * - Commands (imperative): inline or OpenAPI-typed payloads
 * - Results (-ok / -failed): success payloads or CommandError
 * - SSE payloads: OpenAPI-typed
 * - UI events: never cross HTTP
 */
export type EventMap = {

  // ========================================================================
  // YIELD FLOW — resource creation, update, move, clone
  // ========================================================================

  // Domain events
  'yield:created': StoredEvent<ResourceCreatedEvent>;
  'yield:cloned': StoredEvent<ResourceClonedEvent>;
  'yield:updated': StoredEvent<ResourceUpdatedEvent>;
  'yield:moved': StoredEvent<ResourceMovedEvent>;
  'yield:representation-added': StoredEvent<RepresentationAddedEvent>;
  'yield:representation-removed': StoredEvent<RepresentationRemovedEvent>;

  // SSE stream payloads
  'yield:progress': YieldProgress;
  'yield:finished': YieldProgress;
  'yield:failed': components['schemas']['YieldStreamError'];

  // Commands
  'yield:request': {
    annotationId: AnnotationId;
    resourceId: ResourceId;
    options: {
      title: string;
      prompt?: string;
      language?: string;
      temperature?: number;
      maxTokens?: number;
      context: GatheredContext;
      storageUri: string;
    };
  };
  'yield:create': {
    name: string;
    storageUri: string;
    contentChecksum: string;
    byteSize: number;
    format: components['schemas']['ContentFormat'];
    userId: UserId;
    language?: string;
    entityTypes?: string[];
    creationMethod?: CreationMethod;
    isDraft?: boolean;
    generatedFrom?: { resourceId: string; annotationId: string };
    generationPrompt?: string;
    generator?: components['schemas']['Agent'] | components['schemas']['Agent'][];
    noGit?: boolean;
  };
  'yield:update': {
    resourceId: ResourceId;
    storageUri: string;
    contentChecksum: string;
    byteSize: number;
    userId: UserId;
    noGit?: boolean;
  };
  'yield:mv': {
    fromUri: string;
    toUri: string;
    userId: UserId;
    noGit?: boolean;
  };
  'yield:clone': void;

  // Clone token operations
  'yield:clone-token-requested': { correlationId: string; resourceId: ResourceId };
  'yield:clone-resource-requested': { correlationId: string; token: string };
  'yield:clone-create': {
    correlationId: string;
    token: string;
    name: string;
    content: string;
    userId: UserId;
    archiveOriginal?: boolean;
  };

  // Command results
  'yield:create-ok': { resourceId: ResourceId; resource: components['schemas']['ResourceDescriptor'] };
  'yield:create-failed': components['schemas']['CommandError'];
  'yield:update-ok': { resourceId: ResourceId };
  'yield:update-failed': { resourceId: ResourceId } & components['schemas']['CommandError'];
  'yield:move-ok': { resourceId: ResourceId };
  'yield:move-failed': { fromUri: string } & components['schemas']['CommandError'];
  'yield:clone-token-generated': { correlationId: string; response: components['schemas']['CloneResourceWithTokenResponse'] };
  'yield:clone-token-failed': { correlationId: string } & components['schemas']['CommandError'];
  'yield:clone-resource-result': { correlationId: string; response: components['schemas']['GetResourceByTokenResponse'] };
  'yield:clone-resource-failed': { correlationId: string } & components['schemas']['CommandError'];
  'yield:clone-created': { correlationId: string; response: { resourceId: ResourceId } };
  'yield:clone-create-failed': { correlationId: string } & components['schemas']['CommandError'];

  // ========================================================================
  // MARK FLOW — annotation CRUD, entity types, AI assist
  // ========================================================================

  // Domain events
  'mark:added': StoredEvent<AnnotationAddedEvent>;
  'mark:removed': StoredEvent<AnnotationRemovedEvent>;
  'mark:body-updated': StoredEvent<AnnotationBodyUpdatedEvent>;
  'mark:entity-tag-added': StoredEvent<EntityTagAddedEvent>;
  'mark:entity-tag-removed': StoredEvent<EntityTagRemovedEvent>;
  'mark:entity-type-added': StoredEvent<EntityTypeAddedEvent>;
  'mark:archived': StoredEvent<ResourceArchivedEvent>;
  'mark:unarchived': StoredEvent<ResourceUnarchivedEvent>;

  // SSE stream payloads
  'mark:progress': components['schemas']['MarkProgress'];
  'mark:assist-finished': components['schemas']['MarkAssistFinished'];
  'mark:assist-failed': components['schemas']['MarkAssistFailed'];

  // Commands
  'mark:create': { annotation: Annotation; userId: UserId; resourceId: ResourceId };
  'mark:delete': { annotationId: AnnotationId; userId?: UserId; resourceId?: ResourceId };
  'mark:update-body': {
    annotationId: AnnotationId;
    userId: UserId;
    resourceId: ResourceId;
    operations: BodyOperation[];
  };
  'mark:archive': void | { userId: UserId; resourceId?: ResourceId; storageUri?: string; keepFile?: boolean; noGit?: boolean };
  'mark:unarchive': void | { userId: UserId; resourceId?: ResourceId; storageUri?: string };
  'mark:update-entity-types': {
    resourceId: ResourceId;
    userId: UserId;
    currentEntityTypes: string[];
    updatedEntityTypes: string[];
  };
  'mark:add-entity-type': { tag: string; userId: UserId };

  // Command results
  'mark:create-ok': { annotationId: AnnotationId };
  'mark:create-failed': components['schemas']['CommandError'];
  'mark:delete-ok': { annotationId: AnnotationId };
  'mark:delete-failed': components['schemas']['CommandError'];
  'mark:body-update-failed': components['schemas']['CommandError'];
  'mark:entity-type-add-failed': components['schemas']['CommandError'];

  // UI events (frontend-only)
  'mark:select-comment': SelectionData;
  'mark:select-tag': SelectionData;
  'mark:select-assessment': SelectionData;
  'mark:select-reference': SelectionData;
  'mark:requested': { selector: Selector | Selector[]; motivation: Motivation };
  'mark:cancel-pending': void;
  'mark:submit': { motivation: Motivation; selector: Selector | Selector[]; body: components['schemas']['AnnotationBody'][] };
  'mark:assist-request': {
    motivation: Motivation;
    options: {
      instructions?: string;
      tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical' | 'analytical' | 'critical' | 'balanced' | 'constructive';
      density?: number;
      language?: string;
      entityTypes?: string[];
      includeDescriptiveReferences?: boolean;
      schemaId?: string;
      categories?: string[];
    };
  };
  'mark:assist-cancelled': void;
  'mark:progress-dismiss': void;
  'mark:mode-toggled': void;
  'mark:selection-changed': { motivation: string | null };
  'mark:click-changed': { action: string };
  'mark:shape-changed': { shape: string };

  // ========================================================================
  // BIND FLOW — reference linking
  // ========================================================================

  // Commands
  'bind:initiate': {
    annotationId: AnnotationId;
    resourceId: ResourceId;
    defaultTitle: string;
    entityTypes: string[];
  };
  'bind:update-body': {
    annotationId: AnnotationId;
    resourceId: ResourceId;
    userId?: UserId;
    operations: Array<{
      op: 'add' | 'remove' | 'replace';
      item?: components['schemas']['AnnotationBody'];
      oldItem?: components['schemas']['AnnotationBody'];
      newItem?: components['schemas']['AnnotationBody'];
    }>;
  };

  // Results
  'bind:body-updated': { annotationId: AnnotationId };
  'bind:body-update-failed': components['schemas']['CommandError'];

  // SSE stream payloads
  'bind:finished': components['schemas']['BindStreamFinished'];
  'bind:failed': components['schemas']['BindStreamFailed'];

  // ========================================================================
  // MATCH FLOW — search
  // ========================================================================

  // Commands
  'match:search-requested': {
    correlationId: string;
    referenceId: string;
    context: GatheredContext;
    limit?: number;
    useSemanticScoring?: boolean;
  };

  // SSE stream payloads
  'match:search-results': components['schemas']['MatchSearchResult'];
  'match:search-failed': components['schemas']['MatchSearchFailed'];

  // ========================================================================
  // GATHER FLOW — context gathering
  // ========================================================================

  // Commands
  'gather:requested': {
    correlationId: string;
    annotationId: AnnotationId;
    resourceId: ResourceId;
    options?: {
      includeSourceContext?: boolean;
      includeTargetContext?: boolean;
      contextWindow?: number;
    };
  };
  'gather:complete': {
    correlationId: string;
    annotationId: AnnotationId;
    response: components['schemas']['AnnotationLLMContextResponse'];
  };
  'gather:failed': { correlationId: string; annotationId: AnnotationId } & components['schemas']['CommandError'];

  'gather:resource-requested': {
    correlationId: string;
    resourceId: ResourceId;
    options: {
      depth: number;
      maxResources: number;
      includeContent: boolean;
      includeSummary: boolean;
    };
  };
  'gather:resource-complete': {
    correlationId: string;
    resourceId: ResourceId;
    response: components['schemas']['ResourceLLMContextResponse'];
  };
  'gather:resource-failed': { correlationId: string; resourceId: ResourceId } & components['schemas']['CommandError'];

  // SSE stream payloads
  'gather:annotation-progress': components['schemas']['GatherProgress'];
  'gather:annotation-finished': components['schemas']['GatherAnnotationFinished'];
  'gather:progress': components['schemas']['GatherProgress'];
  'gather:finished': components['schemas']['GatherFinished'];

  // ========================================================================
  // BROWSE FLOW — knowledge base reads + UI navigation
  // ========================================================================

  // Reads (correlation-based request/response)
  'browse:resource-requested': { correlationId: string; resourceId: ResourceId };
  'browse:resource-result': { correlationId: string; response: components['schemas']['GetResourceResponse'] };
  'browse:resource-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:resources-requested': {
    correlationId: string;
    search?: string;
    archived?: boolean;
    entityType?: string;
    offset?: number;
    limit?: number;
  };
  'browse:resources-result': { correlationId: string; response: components['schemas']['ListResourcesResponse'] };
  'browse:resources-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:annotations-requested': { correlationId: string; resourceId: ResourceId };
  'browse:annotations-result': { correlationId: string; response: components['schemas']['GetAnnotationsResponse'] };
  'browse:annotations-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:annotation-requested': { correlationId: string; resourceId: ResourceId; annotationId: AnnotationId };
  'browse:annotation-result': { correlationId: string; response: components['schemas']['GetAnnotationResponse'] };
  'browse:annotation-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:events-requested': { correlationId: string; resourceId: ResourceId; type?: string; userId?: string; limit?: number };
  'browse:events-result': { correlationId: string; response: components['schemas']['GetEventsResponse'] };
  'browse:events-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:annotation-history-requested': { correlationId: string; resourceId: ResourceId; annotationId: AnnotationId };
  'browse:annotation-history-result': { correlationId: string; response: components['schemas']['GetAnnotationHistoryResponse'] };
  'browse:annotation-history-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:referenced-by-requested': { correlationId: string; resourceId: ResourceId; motivation?: string };
  'browse:referenced-by-result': { correlationId: string; response: components['schemas']['GetReferencedByResponse'] };
  'browse:referenced-by-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:entity-types-requested': { correlationId: string };
  'browse:entity-types-result': { correlationId: string; response: components['schemas']['GetEntityTypesResponse'] };
  'browse:entity-types-failed': { correlationId: string } & components['schemas']['CommandError'];

  'browse:directory-requested': { correlationId: string; path: string; sort?: 'name' | 'mtime' | 'annotationCount' };
  'browse:directory-result': { correlationId: string; response: { path: string; entries: components['schemas']['DirectoryEntry'][] } };
  'browse:directory-failed': { correlationId: string; path: string } & components['schemas']['CommandError'];

  // UI events (frontend-only)
  'browse:click': { annotationId: string; motivation: Motivation };
  'browse:panel-toggle': { panel: string };
  'browse:panel-open': { panel: string; scrollToAnnotationId?: string; motivation?: string };
  'browse:panel-close': void;
  'browse:sidebar-toggle': void;
  'browse:resource-close': { resourceId: string };
  'browse:resource-reorder': { oldIndex: number; newIndex: number };
  'browse:link-clicked': { href: string; label?: string };
  'browse:router-push': { path: string; reason?: string };
  'browse:external-navigate': { url: string; resourceId?: string; cancelFallback: () => void };
  'browse:reference-navigate': { resourceId: string };
  'browse:entity-type-clicked': { entityType: string };

  // ========================================================================
  // BECKON FLOW — annotation attention
  // ========================================================================

  'beckon:hover': { annotationId: string | null };
  'beckon:focus': { annotationId?: string; resourceId?: string };
  'beckon:sparkle': { annotationId: string };

  // ========================================================================
  // JOB FLOW — worker commands + domain events
  // ========================================================================

  // Domain events
  'job:started': StoredEvent<JobStartedEvent>;
  'job:progress': StoredEvent<JobProgressEvent>;
  'job:completed': StoredEvent<JobCompletedEvent>;
  'job:failed': StoredEvent<JobFailedEvent>;

  // Commands
  'job:start': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: components['schemas']['JobType'];
  };
  'job:report-progress': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: components['schemas']['JobType'];
    percentage: number;
    progress?: Record<string, unknown>;
  };
  'job:complete': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: components['schemas']['JobType'];
    result?: Record<string, unknown>;
  };
  'job:fail': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: components['schemas']['JobType'];
    error: string;
  };
  'job:queued': { jobId: string; jobType: string; resourceId: string };
  'job:cancel-requested': { jobType: 'annotation' | 'generation' };
  'job:status-requested': { correlationId: string; jobId: JobId };

  // Results
  'job:status-result': { correlationId: string; response: components['schemas']['JobStatusResponse'] };
  'job:status-failed': { correlationId: string } & components['schemas']['CommandError'];

  // ========================================================================
  // EMBEDDING FLOW — Smelter commands; domain events are in event-catalog.ts
  // ========================================================================

  'embedding:compute': {
    resourceId: ResourceId;
    annotationId?: AnnotationId;
    chunkIndex: number;
    chunkText: string;
    embedding: number[];
    model: string;
    dimensions: number;
  };
  'embedding:delete': {
    resourceId: ResourceId;
    annotationId?: AnnotationId;
  };

  // ========================================================================
  // SETTINGS (frontend-only)
  // ========================================================================

  'settings:theme-changed': { theme: 'light' | 'dark' | 'system' };
  'settings:line-numbers-toggled': void;
  'settings:locale-changed': { locale: string };
  'settings:hover-delay-changed': { hoverDelayMs: number };

  // ========================================================================
  // SSE infrastructure
  // ========================================================================

  'stream-connected': Record<string, never>;
};

/** Any valid channel name on the EventBus. */
export type EventName = keyof EventMap;
