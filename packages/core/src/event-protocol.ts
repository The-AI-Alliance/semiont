/**
 * Event Protocol Types
 *
 * Type definitions for the application's event-driven architecture.
 * Single source of truth for all EventBus event types.
 */

import type { ResourceEvent, BodyOperation, StoredEvent } from './stored-events';
import type { components } from './types';
import type { ResourceId, AnnotationId, UserId } from './identifiers';
import type { JobId } from './branded-types';
import type { CreationMethod } from './creation-methods';

// W3C Annotation selector types
export type Selector =
  | components['schemas']['TextPositionSelector']
  | components['schemas']['TextQuoteSelector']
  | components['schemas']['SvgSelector']
  | components['schemas']['FragmentSelector'];

export type GatheredContext = components['schemas']['GatheredContext'];

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

/** OpenAPI-derived type for yield progress SSE payloads */
export type YieldProgress = components['schemas']['YieldProgress'];

/** OpenAPI-derived type for user selection data */
export type SelectionData = components['schemas']['SelectionData'];

/** OpenAPI-derived type for mark progress SSE payloads */
export type MarkProgress = components['schemas']['MarkProgress'];

/**
 * Unified event map for all application events
 *
 * Organized by workflow ("flows") and actor sections:
 * 1. Yield Flow - Resource generation from references
 * 2. Mark Flow - Manual + AI-assisted annotation (all motivations)
 * 3. Bind Flow - Reference linking/resolution (search modal)
 * 4. Matcher Flow - Candidate search for bind/link operations
 * 5. Gather Flow - LLM context fetching from annotations
 * 6. Browse Flow - Panel, sidebar, and application routing
 * 7. Beckon Flow - Annotation hover/focus/sparkle coordination
 *
 * Plus infrastructure events (domain events, SSE, resource operations, settings)
 */
export type EventMap = {

  // ========================================================================
  // YIELD FLOW
  // ========================================================================
  // Resource generation from reference annotations

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
  'yield:progress': YieldProgress;
  'yield:finished': YieldProgress;
  'yield:failed': components['schemas']['YieldStreamError'];

  // Domain Events (from backend event store) — published as StoredEvent (includes metadata)
  'yield:created': StoredEvent<Extract<ResourceEvent, { type: 'yield:created' }>>;
  'yield:cloned': StoredEvent<Extract<ResourceEvent, { type: 'yield:cloned' }>>;
  'yield:updated': StoredEvent<Extract<ResourceEvent, { type: 'yield:updated' }>>;
  'yield:moved': StoredEvent<Extract<ResourceEvent, { type: 'yield:moved' }>>;
  'yield:representation-added': StoredEvent<Extract<ResourceEvent, { type: 'yield:representation-added' }>>;
  'yield:representation-removed': StoredEvent<Extract<ResourceEvent, { type: 'yield:representation-removed' }>>;

  // Resource operations
  'yield:create': {
    name: string;
    content?: Buffer;           // Bytes to write (API/GUI/AI path). Omit when file already exists on disk (CLI path).
    storageUri?: string;        // Working-tree URI (e.g. file://docs/overview.md). Required for CLI path.
    contentChecksum?: string;   // SHA-256 for CLI path verification. Computed from content when content is provided.
    format: components['schemas']['ContentFormat'];
    userId: UserId;
    language?: string;
    entityTypes?: string[];
    creationMethod?: CreationMethod;
    isDraft?: boolean;
    generatedFrom?: { resourceId: string; annotationId: string };
    generationPrompt?: string;
    generator?: components['schemas']['Agent'] | components['schemas']['Agent'][];
    noGit?: boolean;            // Skip git operations even when gitSync is configured
  };
  'yield:create-ok': {
    resourceId: ResourceId;
    resource: components['schemas']['ResourceDescriptor'];
  };
  'yield:create-failed': { error: Error };

  'yield:update': {
    resourceId: ResourceId;
    storageUri: string;          // file:// URI of the file that changed
    content?: Buffer;            // New content (API/GUI/AI path). Omit when file already exists on disk (CLI path).
    contentChecksum: string;     // SHA-256 of new content
    userId: UserId;
    noGit?: boolean;             // Skip git operations even when gitSync is configured
  };
  'yield:update-ok': { resourceId: ResourceId };
  'yield:update-failed': { resourceId: ResourceId; error: Error };

  'yield:mv': {
    fromUri: string;   // Previous file:// URI
    toUri: string;     // New file:// URI
    userId: UserId;
    noGit?: boolean;   // Skip git mv even when .git/ exists
  };
  'yield:move-ok': { resourceId: ResourceId };
  'yield:move-failed': { fromUri: string; error: Error };

  'yield:clone': void;

  // Clone token operations (CloneTokenManager handles these)
  'yield:clone-token-requested': {
    correlationId: string;
    resourceId: ResourceId;
  };
  'yield:clone-token-generated': {
    correlationId: string;
    response: components['schemas']['CloneResourceWithTokenResponse'];
  };
  'yield:clone-token-failed': {
    correlationId: string;
    error: Error;
  };

  'yield:clone-resource-requested': {
    correlationId: string;
    token: string;
  };
  'yield:clone-resource-result': {
    correlationId: string;
    response: components['schemas']['GetResourceByTokenResponse'];
  };
  'yield:clone-resource-failed': {
    correlationId: string;
    error: Error;
  };

  'yield:clone-create': {
    correlationId: string;
    token: string;
    name: string;
    content: string;
    userId: UserId;
    archiveOriginal?: boolean;
  };
  'yield:clone-created': {
    correlationId: string;
    response: { resourceId: ResourceId };
  };
  'yield:clone-create-failed': {
    correlationId: string;
    error: Error;
  };

  // ========================================================================
  // MARK FLOW
  // ========================================================================
  // Manual annotation (user selections) + AI-assisted annotation

  // Selection requests (user highlighting text)
  'mark:select-comment': SelectionData;
  'mark:select-tag': SelectionData;
  'mark:select-assessment': SelectionData;
  'mark:select-reference': SelectionData;

  // Unified annotation request (all motivations)
  'mark:requested': {
    selector: Selector | Selector[];
    motivation: Motivation;
  };
  'mark:cancel-pending': void;

  // Frontend panel submit — decomposed fields sent to backend via HTTP
  'mark:submit': {
    motivation: Motivation;
    selector: Selector | Selector[];
    body: components['schemas']['AnnotationBody'][];
  };

  // Annotation CRUD operations — always carries fully-assembled annotation
  'mark:create': {
    annotation: Annotation;
    userId: UserId;
    resourceId: ResourceId;
  };
  'mark:create-ok': { annotationId: AnnotationId };
  'mark:create-failed': { error: Error };
  'mark:delete': { annotationId: AnnotationId; userId?: UserId; resourceId?: ResourceId };
  'mark:delete-ok': { annotationId: AnnotationId };
  'mark:delete-failed': { error: Error };
  'mark:update-body': {
    annotationId: AnnotationId;
    userId: UserId;
    resourceId: ResourceId;
    operations: BodyOperation[];
  };
  'mark:body-update-failed': { error: Error };

  // AI-Assisted Annotation
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
  'mark:progress': components['schemas']['MarkProgress'];
  'mark:assist-finished': components['schemas']['MarkAssistFinished'];
  'mark:assist-failed': components['schemas']['MarkAssistFailed'];
  'mark:assist-cancelled': void;
  'mark:progress-dismiss': void;

  // Toolbar state (annotation UI controls)
  'mark:mode-toggled': void;
  'mark:selection-changed': { motivation: string | null };
  'mark:click-changed': { action: string };
  'mark:shape-changed': { shape: string };

  // Domain Events (from backend event store) — published as StoredEvent (includes metadata)
  'mark:added': StoredEvent<Extract<ResourceEvent, { type: 'mark:added' }>>;
  'mark:removed': StoredEvent<Extract<ResourceEvent, { type: 'mark:removed' }>>;
  'mark:body-updated': StoredEvent<Extract<ResourceEvent, { type: 'mark:body-updated' }>>;
  'mark:entity-tag-added': StoredEvent<Extract<ResourceEvent, { type: 'mark:entity-tag-added' }>>;
  'mark:entity-tag-removed': StoredEvent<Extract<ResourceEvent, { type: 'mark:entity-tag-removed' }>>;

  // Entity type update commands (resource-scoped)
  'mark:update-entity-types': {
    resourceId: ResourceId;
    userId: UserId;
    currentEntityTypes: string[];
    updatedEntityTypes: string[];
  };

  // Entity type addition (system-level, not resource-scoped)
  'mark:add-entity-type': {
    tag: string;
    userId: UserId;
  };
  'mark:entity-type-added': StoredEvent<Extract<ResourceEvent, { type: 'mark:entity-type-added' }>>;
  'mark:entity-type-add-failed': { error: Error };

  // Resource management
  // Command/Event pairs: UI emits command → Backend confirms with domain event

  // Archive command (UI) → archived event (backend confirmation via SSE)
  // Frontend emits void (undefined); backend route enriches with userId + resourceId + storageUri
  // keepFile: if true, use git rm --cached (remove from index only, keep file on disk)
  'mark:archive': void | { userId: UserId; resourceId?: ResourceId; storageUri?: string; keepFile?: boolean; noGit?: boolean };
  'mark:archived': StoredEvent<Extract<ResourceEvent, { type: 'mark:archived' }>>;

  // Unarchive command (UI) → unarchived event (backend confirmation via SSE)
  // Frontend emits void (undefined); backend route enriches with userId + resourceId
  'mark:unarchive': void | { userId: UserId; resourceId?: ResourceId; storageUri?: string };
  'mark:unarchived': StoredEvent<Extract<ResourceEvent, { type: 'mark:unarchived' }>>;

  // ========================================================================
  // BIND FLOW
  // ========================================================================
  // Reference linking and resolution (search modal)

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
  'bind:body-updated': { annotationId: AnnotationId };
  'bind:body-update-failed': { error: Error };
  'bind:finished': components['schemas']['BindStreamFinished'];
  'bind:failed': components['schemas']['BindStreamFailed'];

  // ========================================================================
  // MATCHER FLOW
  // ========================================================================
  // Knowledge base graph reads (Matcher actor handles these)

  'match:search-requested': {
    correlationId: string;
    referenceId: string;
    context: GatheredContext;
    limit?: number;
    useSemanticScoring?: boolean;
  };
  'match:search-results': components['schemas']['MatchSearchResult'];
  'match:search-failed': components['schemas']['MatchSearchFailed'];

  // ========================================================================
  // GATHER FLOW
  // ========================================================================
  // LLM context gathering from annotations for generation

  // Annotation-level context (for yield flow and LLM context endpoint)
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
  'gather:failed': {
    correlationId: string;
    annotationId: AnnotationId;
    error: Error;
  };

  // Annotation-level gather SSE events (streaming transport)
  'gather:annotation-progress': components['schemas']['GatherProgress'];
  'gather:annotation-finished': components['schemas']['GatherAnnotationFinished'];

  // Resource-level context (for LLM context endpoint)
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
  'gather:resource-failed': {
    correlationId: string;
    resourceId: ResourceId;
    error: Error;
  };

  // Resource-level gather SSE events (streaming transport)
  'gather:progress': components['schemas']['GatherProgress'];
  'gather:finished': components['schemas']['GatherFinished'];

  // ========================================================================
  // BROWSE FLOW
  // ========================================================================
  // Panel, sidebar, and application routing

  // annotation click
  'browse:click': { annotationId: string; motivation: Motivation };

  // right toolbar panels
  'browse:panel-toggle': { panel: string };
  'browse:panel-open': { panel: string; scrollToAnnotationId?: string; motivation?: string };
  'browse:panel-close': void;

  // left sidebar navigation
  'browse:sidebar-toggle': void;
  'browse:resource-close': { resourceId: string };
  'browse:resource-reorder': { oldIndex: number; newIndex: number };
  'browse:link-clicked': { href: string; label?: string };
  'browse:router-push': { path: string; reason?: string };
  'browse:external-navigate': { url: string; resourceId?: string; cancelFallback: () => void };
  'browse:reference-navigate': { resourceId: string };
  'browse:entity-type-clicked': { entityType: string };

  // Knowledge base reads (Gatherer handles these)
  'browse:resource-requested': {
    correlationId: string;
    resourceId: ResourceId;
  };
  'browse:resource-result': {
    correlationId: string;
    response: components['schemas']['GetResourceResponse'];
  };
  'browse:resource-failed': {
    correlationId: string;
    error: Error;
  };

  'browse:resources-requested': {
    correlationId: string;
    search?: string;
    archived?: boolean;
    entityType?: string;
    offset?: number;
    limit?: number;
  };
  'browse:resources-result': {
    correlationId: string;
    response: components['schemas']['ListResourcesResponse'];
  };
  'browse:resources-failed': {
    correlationId: string;
    error: Error;
  };

  'browse:annotations-requested': {
    correlationId: string;
    resourceId: ResourceId;
  };
  'browse:annotations-result': {
    correlationId: string;
    response: components['schemas']['GetAnnotationsResponse'];
  };
  'browse:annotations-failed': {
    correlationId: string;
    error: Error;
  };

  'browse:annotation-requested': {
    correlationId: string;
    resourceId: ResourceId;
    annotationId: AnnotationId;
  };
  'browse:annotation-result': {
    correlationId: string;
    response: components['schemas']['GetAnnotationResponse'];
  };
  'browse:annotation-failed': {
    correlationId: string;
    error: Error;
  };

  'browse:events-requested': {
    correlationId: string;
    resourceId: ResourceId;
    type?: string;
    userId?: string;
    limit?: number;
  };
  'browse:events-result': {
    correlationId: string;
    response: components['schemas']['GetEventsResponse'];
  };
  'browse:events-failed': {
    correlationId: string;
    error: Error;
  };

  'browse:annotation-history-requested': {
    correlationId: string;
    resourceId: ResourceId;
    annotationId: AnnotationId;
  };
  'browse:annotation-history-result': {
    correlationId: string;
    response: components['schemas']['GetAnnotationHistoryResponse'];
  };
  'browse:annotation-history-failed': {
    correlationId: string;
    error: Error;
  };

  // Knowledge base graph reads (Browser handles these)
  'browse:referenced-by-requested': {
    correlationId: string;
    resourceId: ResourceId;
    motivation?: string;
  };
  'browse:referenced-by-result': {
    correlationId: string;
    response: components['schemas']['GetReferencedByResponse'];
  };
  'browse:referenced-by-failed': {
    correlationId: string;
    error: Error;
  };

  // Knowledge base entity type listing (Browser handles this read)
  'browse:entity-types-requested': {
    correlationId: string;
  };
  'browse:entity-types-result': {
    correlationId: string;
    response: components['schemas']['GetEntityTypesResponse'];
  };
  'browse:entity-types-failed': {
    correlationId: string;
    error: Error;
  };

  // Knowledge base filesystem reads (Browser handles these)
  'browse:directory-requested': {
    correlationId: string;
    path:          string;
    sort?:         'name' | 'mtime' | 'annotationCount';
  };
  'browse:directory-result': {
    correlationId: string;
    response: {
      path:    string;
      entries: components['schemas']['DirectoryEntry'][];
    };
  };
  'browse:directory-failed': {
    correlationId: string;
    path:          string;
    error:         Error;
  };

  // ========================================================================
  // BECKON FLOW
  // ========================================================================
  // Manages which annotation has user's attention (hover/click/focus)

  'beckon:hover': { annotationId: string | null };
  'beckon:focus': { annotationId?: string; resourceId?: string };
  'beckon:sparkle': { annotationId: string };

  // ========================================================================
  // Job control
  // ========================================================================

  // Commands (worker → Stower via EventBus)
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

  // Domain Events (from backend event store) — published as StoredEvent (includes metadata)
  'job:started': StoredEvent<Extract<ResourceEvent, { type: 'job:started' }>>;
  'job:progress': StoredEvent<Extract<ResourceEvent, { type: 'job:progress' }>>;
  'job:completed': StoredEvent<Extract<ResourceEvent, { type: 'job:completed' }>>;
  'job:failed': StoredEvent<Extract<ResourceEvent, { type: 'job:failed' }>>;

  // Job operations
  'job:queued': { jobId: string; jobType: string; resourceId: string };
  'job:cancel-requested': { jobType: 'annotation' | 'generation' };

  // Job status reads
  'job:status-requested': {
    correlationId: string;
    jobId: JobId;
  };
  'job:status-result': {
    correlationId: string;
    response: components['schemas']['JobStatusResponse'];
  };
  'job:status-failed': {
    correlationId: string;
    error: Error;
  };

  // ========================================================================
  // Settings
  // ========================================================================

  'settings:theme-changed': { theme: 'light' | 'dark' | 'system' };
  'settings:line-numbers-toggled': void;
  'settings:locale-changed': { locale: string };
  'settings:hover-delay-changed': { hoverDelayMs: number };

  // ========================================================================
  // EMBEDDING EVENTS
  // ========================================================================
  // Computed by the Smelter actor, persisted by the Stower in .semiont/events/

  'embedding:computed': {
    resourceId: ResourceId;
    annotationId?: AnnotationId;
    chunkIndex: number;
    chunkText: string;
    embedding: number[];
    model: string;
    dimensions: number;
  };

  'embedding:deleted': {
    resourceId: ResourceId;
    annotationId?: AnnotationId;
  };

  // SSE infrastructure event — emitted by the backend as the first event on a stream
  // to signal that the connection is established. Not a domain event.
  'stream-connected': Record<string, never>;

};

/**
 * Union type of all valid event names
 * Use this to enforce compile-time checking of event names
 */
export type EventName = keyof EventMap;

