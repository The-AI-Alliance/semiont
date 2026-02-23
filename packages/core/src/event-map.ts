/**
 * Event Protocol Types
 *
 * Type definitions for the application's event-driven architecture.
 * Single source of truth for all EventBus event types.
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

/**
 * Progress state for resource generation workflow
 */
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
 * Progress state for annotation detection workflow
 *
 * Unified progress interface supporting different detection strategies:
 * - Reference detection: entity-type steps
 * - Other motivations: percentage-based progress
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

/**
 * Unified event map for all application events
 *
 * Organized by workflow ("flows"):
 * 1. Attention Flow - Annotation hover/focus/sparkle coordination
 * 2. Detection Flow - Manual + AI annotation detection (all motivations)
 * 3. Context Retrieval Flow - LLM context fetching from annotations
 * 4. Generation Flow - Resource generation from references
 * 5. Resolution Flow - Reference linking/resolution (search modal)
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
  // ATTENTION FLOW
  // ========================================================================
  // Manages which annotation has user's attention (hover/click/focus)

  'attend:hover': { annotationId: string | null };
  'attend:click': { annotationId: string; motivation: Motivation };
  'attend:focus': { annotationId: string | null };
  'attend:sparkle': { annotationId: string };

  // ========================================================================
  // ANNOTATION FLOW
  // ========================================================================
  // Manual annotation (user selections) + AI-assisted annotation (detection)

  // Selection requests (user highlighting text)
  'annotate:select-comment': SelectionData;
  'annotate:select-tag': SelectionData;
  'annotate:select-assessment': SelectionData;
  'annotate:select-reference': SelectionData;

  // Unified annotation request (all motivations)
  'annotate:requested': {
    selector: Selector | Selector[];
    motivation: Motivation;
  };
  'annotate:cancel-pending': void;

  // Annotation CRUD operations
  'annotate:create': {
    motivation: Motivation;
    selector: Selector | Selector[];
    body: components['schemas']['AnnotationBody'][];
  };
  'annotate:created': { annotation: Annotation };
  'annotate:create-failed': { error: Error };
  'annotate:delete': { annotationId: string };
  'annotate:deleted': { annotationId: string };
  'annotate:delete-failed': { error: Error };

  // AI-Assisted Annotation (Detection)
  'annotate:detect-request': {
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
  'annotate:detect-progress': DetectionProgress;
  'annotate:detect-finished': { motivation?: Motivation; resourceUri?: ResourceUri; progress?: DetectionProgress };
  'annotate:detect-failed': Extract<ResourceEvent, { type: 'job.failed' }>;
  'annotate:detect-cancelled': void;
  'annotate:detect-dismiss': void;

  // ========================================================================
  // RESOLUTION FLOW
  // ========================================================================
  // Reference linking and resolution (search modal)

  'resolve:create-manual': {
    annotationUri: string;
    title: string;
    entityTypes: string[];
  };
  'resolve:link': {
    annotationUri: string;
    searchTerm: string;
  };
  'resolve:search-requested': {
    referenceId: string;
    searchTerm: string;
  };
  'resolve:update-body': {
    annotationUri: string;
    resourceId: string;
    operations: Array<{
      op: 'add' | 'remove' | 'replace';
      item?: components['schemas']['AnnotationBody'];
      oldItem?: components['schemas']['AnnotationBody'];
      newItem?: components['schemas']['AnnotationBody'];
    }>;
  };
  'resolve:body-updated': { annotationUri: string };
  'resolve:body-update-failed': { error: Error };

  // ========================================================================
  // CONTEXT CORRELATION FLOW
  // ========================================================================
  // LLM context correlation from annotations for generation

  'correlate:requested': {
    annotationUri: string;
    resourceUri: string;
  };
  'correlate:complete': {
    annotationUri: string;
    context: GenerationContext;
  };
  'correlate:failed': {
    annotationUri: string;
    error: Error;
  };

  // ========================================================================
  // GENERATION FLOW
  // ========================================================================
  // Resource generation from reference annotations

  'generate:modal-open': {
    annotationUri: string;
    resourceUri: string;
    defaultTitle: string;
  };
  'generate:request': {
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
  'generate:progress': GenerationProgress;
  'generate:finished': GenerationProgress;
  'generate:failed': { error: Error };

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
