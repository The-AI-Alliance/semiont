/**
 * Event Protocol Types
 *
 * Unified event map for all application events.
 * This is the single source of truth for event types across backend, frontend, and CLI.
 *
 * Consolidates events from:
 * - Backend events (SSE streams, job progress, resource operations)
 * - User interaction events (selection, annotation hover/click, panels, toolbar)
 * - Navigation events (sidebar, routing, links)
 * - Settings events (theme, line numbers, locale)
 * - API operation events (CRUD, detection, generation)
 */

import type { ResourceEvent } from './events';
import type { components } from './types';
import type { ResourceUri } from './branded-types';

// W3C Annotation selector types
export type Selector =
  | components['schemas']['TextPositionSelector']
  | components['schemas']['TextQuoteSelector']
  | components['schemas']['SvgSelector']
  | components['schemas']['FragmentSelector'];

export type GenerationContext = components['schemas']['GenerationContext'];

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

// GenerationProgress interface (SSE stream progress updates)
export interface GenerationProgress {
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
 * Common detection progress fields shared across all motivation types.
 *
 * The five motivations have different SSE progress shapes
 * (ReferenceDetectionProgress uses entity-type steps; the others use percentage).
 * This type captures the subset of fields used by the detection UI
 * (DetectionProgressWidget, useDetectionFlow).
 */
export interface DetectionProgress {
  status: string;
  message?: string;
  /** Reference detection: currently scanning entity type */
  currentEntityType?: string;
  /** Reference detection: completed entity types with counts (frontend-only) */
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

// Note: GenerationProgress is imported and re-exported from @semiont/api-client

/**
 * Unified event map for all application events
 *
 * Organized by workflow ("flows"):
 * 1. AttentionFlow - Annotation hover/focus/sparkle coordination
 * 2. DetectionFlow - Manual + AI annotation detection (all motivations)
 * 3. GenerationFlow - Document generation from references
 * 4. ResolutionFlow - Reference linking/resolution (search modal)
 * 5. ContextRetrievalFlow - LLM context fetching from annotations
 *
 * Plus infrastructure events (domain events, SSE, resource operations, navigation, settings)
 */
export type EventMap = {
  // ========================================================================
  // DOMAIN EVENTS (backend event sourcing - dot notation)
  // ========================================================================
  // Emitted by backend via /resources/:id/events/stream SSE endpoint
  // Represent source of truth from event store

  'annotation.added': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'annotation.removed': Extract<ResourceEvent, { type: 'annotation.removed' }>;
  'annotation.body.updated': Extract<ResourceEvent, { type: 'annotation.body.updated' }>;
  'entitytag.added': Extract<ResourceEvent, { type: 'entitytag.added' }>;
  'entitytag.removed': Extract<ResourceEvent, { type: 'entitytag.removed' }>;
  'resource.archived': Extract<ResourceEvent, { type: 'resource.archived' }>;
  'resource.unarchived': Extract<ResourceEvent, { type: 'resource.unarchived' }>;
  'job.started': Extract<ResourceEvent, { type: 'job.started' }>;
  'job.completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'job.failed': Extract<ResourceEvent, { type: 'job.failed' }>;
  'representation.added': Extract<ResourceEvent, { type: 'representation.added' }>;
  'representation.removed': Extract<ResourceEvent, { type: 'representation.removed' }>;

  // Generic domain event (all types)
  'make-meaning:event': ResourceEvent;

  // ========================================================================
  // SSE META EVENTS
  // ========================================================================

  'stream-connected': void;

  // ========================================================================
  // FLOW 1: ATTENTION FLOW (useAttentionFlow)
  // ========================================================================
  // Manages which annotation has user's attention (hover/click/focus)

  'annotation:hover': { annotationId: string | null };
  'annotation:click': { annotationId: string; motivation: Motivation };
  'annotation:focus': { annotationId: string | null };
  'annotation:sparkle': { annotationId: string };

  // ========================================================================
  // FLOW 2: DETECTION FLOW (useDetectionFlow)
  // ========================================================================
  // Manual detection (user selections) + AI detection (SSE streams)

  // Selection requests (user highlighting text)
  'selection:comment-requested': SelectionData;
  'selection:tag-requested': SelectionData;
  'selection:assessment-requested': SelectionData;
  'selection:reference-requested': SelectionData;

  // Unified annotation request (all motivations)
  'annotation:requested': {
    selector: Selector | Selector[];
    motivation: Motivation;
  };
  'annotation:cancel-pending': void;

  // Annotation CRUD operations
  'annotation:create': {
    motivation: Motivation;
    selector: Selector | Selector[];
    body: components['schemas']['AnnotationBody'][];
  };
  'annotation:created': { annotation: Annotation };
  'annotation:create-failed': { error: Error };
  'annotation:delete': { annotationId: string };
  'annotation:deleted': { annotationId: string };
  'annotation:delete-failed': { error: Error };

  // AI Detection (SSE streams)
  'detection:start': {
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
  'detection:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'detection:progress': DetectionProgress;
  'detection:entity-found': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'detection:complete': { motivation?: Motivation; resourceUri?: ResourceUri; progress?: DetectionProgress };
  'detection:completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'detection:failed': Extract<ResourceEvent, { type: 'job.failed' }>;
  'detection:cancelled': void;
  'detection:dismiss-progress': void;

  // ========================================================================
  // FLOW 3: GENERATION FLOW (useGenerationFlow)
  // ========================================================================
  // Document generation from reference annotations

  'generation:modal-open': {
    annotationUri: string;
    resourceUri: string;
    defaultTitle: string;
  };
  'generation:start': {
    annotationUri: string;
    resourceUri: string;
    options: {
      title: string;
      prompt?: string;
      language?: string;
      temperature?: number;
      maxTokens?: number;
      context: GenerationContext;
    };
  };
  'generation:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'generation:progress': GenerationProgress;
  'generation:complete': GenerationProgress;
  'generation:completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'generation:failed': { error: Error };

  // ========================================================================
  // FLOW 4: RESOLUTION FLOW (useResolutionFlow)
  // ========================================================================
  // Reference linking and resolution (search modal)

  'reference:create-manual': {
    annotationUri: string;
    title: string;
    entityTypes: string[];
  };
  'reference:link': {
    annotationUri: string;
    searchTerm: string;
  };
  'resolution:search-requested': {
    referenceId: string;
    searchTerm: string;
  };
  'annotation:update-body': {
    annotationUri: string;
    resourceId: string;
    operations: Array<{
      op: 'add' | 'remove' | 'replace';
      item?: components['schemas']['AnnotationBody'];
      oldItem?: components['schemas']['AnnotationBody'];
      newItem?: components['schemas']['AnnotationBody'];
    }>;
  };
  'annotation:body-updated': { annotationUri: string };
  'annotation:body-update-failed': { error: Error };

  // ========================================================================
  // FLOW 5: CONTEXT RETRIEVAL FLOW (useContextRetrievalFlow)
  // ========================================================================
  // LLM context fetching from annotations

  'context:retrieval-requested': {
    annotationUri: string;
    resourceUri: string;
  };
  'context:retrieval-complete': {
    annotationUri: string;
    context: GenerationContext;
  };
  'context:retrieval-failed': {
    annotationUri: string;
    error: Error;
  };

  // ========================================================================
  // INFRASTRUCTURE: Application-level domain events
  // ========================================================================

  'annotation:added': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'annotation:removed': Extract<ResourceEvent, { type: 'annotation.removed' }>;
  'annotation:updated': Extract<ResourceEvent, { type: 'annotation.body.updated' }>;
  'entity-tag:added': Extract<ResourceEvent, { type: 'entitytag.added' }>;
  'entity-tag:removed': Extract<ResourceEvent, { type: 'entitytag.removed' }>;
  'resource:archived': Extract<ResourceEvent, { type: 'resource.archived' }>;
  'resource:unarchived': Extract<ResourceEvent, { type: 'resource.unarchived' }>;

  // ========================================================================
  // INFRASTRUCTURE: Resource operations
  // ========================================================================

  'resource:archive': void;
  'resource:unarchive': void;
  'resource:clone': void;

  // ========================================================================
  // INFRASTRUCTURE: Job control
  // ========================================================================

  'job:queued': { jobId: string; jobType: string; resourceId: string };
  'job:cancel-requested': { jobType: 'detection' | 'generation' };

  // ========================================================================
  // INFRASTRUCTURE: Panel management
  // ========================================================================

  'panel:toggle': { panel: string };
  'panel:open': { panel: string; scrollToAnnotationId?: string; motivation?: string };
  'panel:close': void;

  // ========================================================================
  // INFRASTRUCTURE: View modes
  // ========================================================================

  'view:mode-toggled': void;

  // ========================================================================
  // INFRASTRUCTURE: Toolbar (annotation UI controls)
  // ========================================================================

  'toolbar:selection-changed': { motivation: string | null };
  'toolbar:click-changed': { action: string };
  'toolbar:shape-changed': { shape: string };

  // ========================================================================
  // INFRASTRUCTURE: Navigation
  // ========================================================================

  'navigation:sidebar-toggle': void;
  'navigation:resource-close': { resourceId: string };
  'navigation:resource-reorder': { oldIndex: number; newIndex: number };
  'navigation:link-clicked': { href: string; label?: string };
  'navigation:router-push': { path: string; reason?: string };
  'navigation:external-navigate': { url: string; resourceId?: string; cancelFallback: () => void };
  'navigation:reference-navigate': { documentId: string };
  'navigation:entity-type-clicked': { entityType: string };

  // ========================================================================
  // INFRASTRUCTURE: Settings
  // ========================================================================

  'settings:theme-changed': { theme: 'light' | 'dark' | 'system' };
  'settings:line-numbers-toggled': void;
  'settings:locale-changed': { locale: string };
};

/**
 * Union type of all valid event names
 * Use this to enforce compile-time checking of event names
 */
export type EventName = keyof EventMap;
