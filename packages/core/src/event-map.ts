/**
 * Event Protocol Types
 *
 * Type definitions for the application's event-driven architecture.
 * Single source of truth for all EventBus event types.
 */

import type { ResourceEvent, BodyOperation } from './events';
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

/**
 * Progress state for resource yield workflow
 */
export interface YieldProgress {
  status: 'started' | 'fetching' | 'generating' | 'creating' | 'complete' | 'error';
  referenceId: string;
  resourceName?: string;
  resourceId?: string;
  sourceResourceId?: string;
  percentage: number;
  message?: string;
}

/**
 * Selection data for user-initiated annotations
 */
export interface SelectionData {
  exact: string;
  start: number;
  end: number;
  svgSelector?: string;
  fragmentSelector?: string;
  conformsTo?: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Progress state for mark workflows (manual and assisted)
 *
 * Unified progress interface supporting different annotation strategies:
 * - Reference annotation: entity-type steps
 * - Other motivations: percentage-based progress
 */
export interface MarkProgress {
  status: string;
  message?: string;
  /** Reference annotation: currently scanning entity type */
  currentEntityType?: string;
  /** Reference annotation: completed entity types with counts (frontend-only) */
  completedEntityTypes?: Array<{ entityType: string; foundCount: number }>;
  /** Percentage-based motivations (highlight, assessment, comment, tag) */
  percentage?: number;
  /** Category-based motivations (tag) */
  currentCategory?: string;
  processedCategories?: number;
  totalCategories?: number;
  /** Request parameters for display in progress UI (frontend-only, added by annotation-registry) */
  requestParams?: Array<{ label: string; value: string }>;
}

/**
 * Unified event map for all application events
 *
 * Organized by workflow ("flows"):
 * 1. Yield Flow - Resource generation from references
 * 2. Mark Flow - Manual + AI-assisted annotation (all motivations)
 * 3. Bind Flow - Reference linking/resolution (search modal)
 * 4. Gather Flow - LLM context fetching from annotations
 * 5. Browse Flow - Panel, sidebar, and application routing
 * 6. Beckon Flow - Annotation hover/focus/sparkle coordination
 *
 * Plus infrastructure events (domain events, SSE, resource operations, settings)
 */
export type EventMap = {

  // ========================================================================
  // DOMAIN EVENTS
  // (Backend Event Sourcing)
  // Generic wrapper for all backend domain events (dot notation)
  // Streamed via SSE from /resources/:id/events/stream endpoint
  // Specific typed domain events are defined within their respective flow sections below
  // ========================================================================

  'make-meaning:event': ResourceEvent;

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
  'yield:failed': { error: Error };

  // Domain Events (from backend event store)
  'yield:representation-added': Extract<ResourceEvent, { type: 'representation.added' }>;
  'yield:representation-removed': Extract<ResourceEvent, { type: 'representation.removed' }>;

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
    generatedFrom?: string;
    generationPrompt?: string;
  };
  'yield:created': {
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
  };
  'yield:updated': { resourceId: ResourceId };
  'yield:update-failed': { resourceId: ResourceId; error: Error };

  'yield:mv': {
    fromUri: string;   // Previous file:// URI
    toUri: string;     // New file:// URI
    userId: UserId;
    noGit?: boolean;   // Skip git mv even when .git/ exists
  };
  'yield:moved': { resourceId: ResourceId };
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
  'mark:created': { annotationId: AnnotationId };
  'mark:create-failed': { error: Error };
  'mark:delete': { annotationId: AnnotationId; userId?: UserId; resourceId?: ResourceId };
  'mark:deleted': { annotationId: AnnotationId };
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
      entityTypes?: string[];
      includeDescriptiveReferences?: boolean;
      schemaId?: string;
      categories?: string[];
    };
  };
  'mark:progress': MarkProgress;
  'mark:assist-finished': { motivation?: Motivation; resourceId?: ResourceId; progress?: MarkProgress };
  'mark:assist-failed': Extract<ResourceEvent, { type: 'job.failed' }>;
  'mark:assist-cancelled': void;
  'mark:progress-dismiss': void;

  // Toolbar state (annotation UI controls)
  'mark:mode-toggled': void;
  'mark:selection-changed': { motivation: string | null };
  'mark:click-changed': { action: string };
  'mark:shape-changed': { shape: string };

  // Domain Events (from backend event store)
  'mark:added': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'mark:removed': Extract<ResourceEvent, { type: 'annotation.removed' }>;
  'mark:body-updated': Extract<ResourceEvent, { type: 'annotation.body.updated' }>;
  'mark:entity-tag-added': Extract<ResourceEvent, { type: 'entitytag.added' }>;
  'mark:entity-tag-removed': Extract<ResourceEvent, { type: 'entitytag.removed' }>;

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
  'mark:entity-type-added': { tag: string };
  'mark:entity-type-add-failed': { error: Error };

  // Entity type listing (Gatherer handles this read)
  'mark:entity-types-requested': {
    correlationId: string;
  };
  'mark:entity-types-result': {
    correlationId: string;
    response: components['schemas']['GetEntityTypesResponse'];
  };
  'mark:entity-types-failed': {
    correlationId: string;
    error: Error;
  };

  // Resource management
  // Command/Event pairs: UI emits command → Backend confirms with domain event

  // Archive command (UI) → archived event (backend confirmation via SSE)
  // Frontend emits void (undefined); backend route enriches with userId + resourceId + storageUri
  // keepFile: if true, use git rm --cached (remove from index only, keep file on disk)
  'mark:archive': void | { userId: UserId; resourceId?: ResourceId; storageUri?: string; keepFile?: boolean };
  'mark:archived': Extract<ResourceEvent, { type: 'resource.archived' }>;

  // Unarchive command (UI) → unarchived event (backend confirmation via SSE)
  // Frontend emits void (undefined); backend route enriches with userId + resourceId
  'mark:unarchive': void | { userId: UserId; resourceId?: ResourceId; storageUri?: string };
  'mark:unarchived': Extract<ResourceEvent, { type: 'resource.unarchived' }>;

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
  'bind:search-requested': {
    correlationId?: string;
    referenceId: string;
    context: GatheredContext;
    limit?: number;
    useSemanticScoring?: boolean;
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
  'bind:search-results': {
    referenceId: string;
    results: Array<components['schemas']['ResourceDescriptor'] & {
      score?: number;
      matchReason?: string;
    }>;
    correlationId?: string;
  };
  'bind:search-failed': {
    referenceId: string;
    error: Error;
    correlationId?: string;
  };

  // Knowledge base graph reads (Matcher handles these)
  'bind:referenced-by-requested': {
    correlationId: string;
    resourceId: ResourceId;
    motivation?: string;
  };
  'bind:referenced-by-result': {
    correlationId: string;
    response: components['schemas']['GetReferencedByResponse'];
  };
  'bind:referenced-by-failed': {
    correlationId: string;
    error: Error;
  };

  // ========================================================================
  // GATHER FLOW
  // ========================================================================
  // LLM context gathering from annotations for generation

  // Annotation-level context (for yield flow and LLM context endpoint)
  'gather:requested': {
    correlationId?: string;
    annotationId: AnnotationId;
    resourceId: ResourceId;
    options?: {
      includeSourceContext?: boolean;
      includeTargetContext?: boolean;
      contextWindow?: number;
    };
  };
  'gather:complete': {
    correlationId?: string;
    annotationId: AnnotationId;
    response: components['schemas']['AnnotationLLMContextResponse'];
  };
  'gather:failed': {
    correlationId?: string;
    annotationId: AnnotationId;
    error: Error;
  };

  // Resource-level context (for LLM context endpoint)
  'gather:resource-requested': {
    correlationId?: string;
    resourceId: ResourceId;
    options: {
      depth: number;
      maxResources: number;
      includeContent: boolean;
      includeSummary: boolean;
    };
  };
  'gather:resource-complete': {
    correlationId?: string;
    resourceId: ResourceId;
    context: components['schemas']['ResourceLLMContextResponse'];
  };
  'gather:resource-failed': {
    correlationId?: string;
    resourceId: ResourceId;
    error: Error;
  };

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
  'browse:reference-navigate': { documentId: string };
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

  // ========================================================================
  // BECKON FLOW
  // ========================================================================
  // Manages which annotation has user's attention (hover/click/focus)

  'beckon:hover': { annotationId: string | null };
  'beckon:focus': { annotationId: string | null };
  'beckon:sparkle': { annotationId: string };

  // ========================================================================
  // Job control
  // ========================================================================

  // Commands (worker → Stower via EventBus)
  'job:start': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: 'reference-annotation' | 'generation' | 'highlight-annotation' | 'assessment-annotation' | 'comment-annotation' | 'tag-annotation';
  };
  'job:report-progress': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: 'reference-annotation' | 'generation' | 'highlight-annotation' | 'assessment-annotation' | 'comment-annotation' | 'tag-annotation';
    percentage: number;
    progress?: any;
  };
  'job:complete': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: 'reference-annotation' | 'generation' | 'highlight-annotation' | 'assessment-annotation' | 'comment-annotation' | 'tag-annotation';
    result?: any;
  };
  'job:fail': {
    resourceId: ResourceId;
    userId: UserId;
    jobId: JobId;
    jobType: 'reference-annotation' | 'generation' | 'highlight-annotation' | 'assessment-annotation' | 'comment-annotation' | 'tag-annotation';
    error: string;
  };

  // Domain Events (from backend event store)
  'job:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'job:progress': Extract<ResourceEvent, { type: 'job.progress' }>;
  'job:completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'job:failed': Extract<ResourceEvent, { type: 'job.failed' }>;

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

};

/**
 * Union type of all valid event names
 * Use this to enforce compile-time checking of event names
 */
export type EventName = keyof EventMap;
