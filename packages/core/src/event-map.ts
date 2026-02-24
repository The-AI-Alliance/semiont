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
 * Progress state for annotation workflows (manual and assisted)
 *
 * Unified progress interface supporting different annotation strategies:
 * - Reference annotation: entity-type steps
 * - Other motivations: percentage-based progress
 */
export interface AnnotationProgress {
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
 * 1. Attention Flow - Annotation hover/focus/sparkle coordination
 * 2. Annotation Flow - Manual + AI-assisted annotation (all motivations)
 * 3. Context Retrieval Flow - LLM context fetching from annotations
 * 4. Generation Flow - Resource generation from references
 * 5. Resolution Flow - Reference linking/resolution (search modal)
 *
 * Plus infrastructure events (domain events, SSE, resource operations, navigation, settings)
 */
export type EventMap = {
  // ========================================================================
  // DOMAIN EVENTS (Backend Event Sourcing)
  // ========================================================================
  // Generic wrapper for all backend domain events (dot notation)
  // Streamed via SSE from /resources/:id/events/stream endpoint
  // Specific typed domain events are defined within their respective flow sections below

  'make-meaning:event': ResourceEvent;

  // ========================================================================
  // ATTENTION FLOW
  // ========================================================================
  // Manages which annotation has user's attention (hover/click/focus)

  'attend:hover': { annotationId: string | null };
  'attend:click': { annotationId: string; motivation: Motivation };
  'attend:focus': { annotationId: string | null };
  'attend:sparkle': { annotationId: string };
  'attend:panel-toggle': { panel: string };
  'attend:panel-open': { panel: string; scrollToAnnotationId?: string; motivation?: string };
  'attend:panel-close': void;

  // ========================================================================
  // ANNOTATION FLOW
  // ========================================================================
  // Manual annotation (user selections) + AI-assisted annotation

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

  // AI-Assisted Annotation
  'annotate:assist-request': {
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
  'annotate:progress': AnnotationProgress;
  'annotate:assist-finished': { motivation?: Motivation; resourceUri?: ResourceUri; progress?: AnnotationProgress };
  'annotate:assist-failed': Extract<ResourceEvent, { type: 'job.failed' }>;
  'annotate:assist-cancelled': void;
  'annotate:progress-dismiss': void;

  // Toolbar state (annotation UI controls)
  'annotate:mode-toggled': void;
  'annotate:selection-changed': { motivation: string | null };
  'annotate:click-changed': { action: string };
  'annotate:shape-changed': { shape: string };

  // Domain Events (from backend event store)
  'annotate:added': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'annotate:removed': Extract<ResourceEvent, { type: 'annotation.removed' }>;
  'annotate:body-updated': Extract<ResourceEvent, { type: 'annotation.body.updated' }>;
  'annotate:entity-tag-added': Extract<ResourceEvent, { type: 'entitytag.added' }>;
  'annotate:entity-tag-removed': Extract<ResourceEvent, { type: 'entitytag.removed' }>;

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

  // Domain Events (from backend event store)
  'generate:representation-added': Extract<ResourceEvent, { type: 'representation.added' }>;
  'generate:representation-removed': Extract<ResourceEvent, { type: 'representation.removed' }>;

  // Resource operations
  'generate:clone': void;

  // ========================================================================
  // Resource management
  // ========================================================================
  // Command/Event pairs: UI emits command → Backend confirms with domain event

  // Archive command (UI) → archived event (backend confirmation via SSE)
  'resource:archive': void;
  'resource:archived': Extract<ResourceEvent, { type: 'resource.archived' }>;

  // Unarchive command (UI) → unarchived event (backend confirmation via SSE)
  'resource:unarchive': void;
  'resource:unarchived': Extract<ResourceEvent, { type: 'resource.unarchived' }>;

  // ========================================================================
  // Job control
  // ========================================================================

  // Domain Events (from backend event store)
  'job:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'job:completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'job:failed': Extract<ResourceEvent, { type: 'job.failed' }>;

  // Job operations
  'job:queued': { jobId: string; jobType: string; resourceId: string };
  'job:cancel-requested': { jobType: 'annotation' | 'generation' };

  // ========================================================================
  // Left Sidebar Navigation
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
