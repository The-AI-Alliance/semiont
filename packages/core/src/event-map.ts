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
type Selector =
  | components['schemas']['TextPositionSelector']
  | components['schemas']['TextQuoteSelector']
  | components['schemas']['SvgSelector']
  | components['schemas']['FragmentSelector'];

type GenerationContext = components['schemas']['GenerationContext'];

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
 */
export type EventMap = {
  // ===== BACKEND EVENTS (from SSE) =====

  // Generic event (all types)
  'make-meaning:event': ResourceEvent;

  // Detection events (backend real-time stream via GET /resources/:id/events/stream)
  'detection:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'detection:entity-found': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'detection:completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'detection:failed': Extract<ResourceEvent, { type: 'job.failed' }>;
  // Detection progress from SSE detection streams (all 5 motivation types)
  'detection:progress': DetectionProgress;

  // Annotation events (backend)
  'annotation:added': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'annotation:removed': Extract<ResourceEvent, { type: 'annotation.removed' }>;
  'annotation:updated': Extract<ResourceEvent, { type: 'annotation.body.updated' }>;

  // Entity tag events (backend)
  'entity-tag:added': Extract<ResourceEvent, { type: 'entitytag.added' }>;
  'entity-tag:removed': Extract<ResourceEvent, { type: 'entitytag.removed' }>;

  // Resource events (backend)
  'resource:archived': Extract<ResourceEvent, { type: 'resource.archived' }>;
  'resource:unarchived': Extract<ResourceEvent, { type: 'resource.unarchived' }>;

  // ===== USER INTERACTION EVENTS =====

  // Selection events (user highlighting text/regions)
  'selection:comment-requested': SelectionData;
  'selection:tag-requested': SelectionData;
  'selection:assessment-requested': SelectionData;
  'selection:reference-requested': SelectionData;

  // Unified annotation request event (all motivations)
  'annotation:requested': {
    selector: Selector | Selector[];
    motivation: Motivation;
  };

  // Annotation interaction events
  'annotation:cancel-pending': void;
  'annotation:hover': { annotationId: string | null }; // Bidirectional hover: annotation overlay ↔ panel entry
  'annotation:click': { annotationId: string; motivation: Motivation }; // Click on annotation - includes motivation for panel coordination
  'annotation:focus': { annotationId: string | null };
  'annotation:sparkle': { annotationId: string };

  // Panel management events
  'panel:toggle': { panel: string };
  'panel:open': { panel: string; scrollToAnnotationId?: string; motivation?: string };
  'panel:close': void;

  // View mode events
  'view:mode-toggled': void;

  // Toolbar events (annotation UI controls)
  'toolbar:selection-changed': { motivation: string | null };
  'toolbar:click-changed': { action: string };
  'toolbar:shape-changed': { shape: string };

  // Navigation events (sidebar UI)
  'navigation:sidebar-toggle': void;
  'navigation:resource-close': { resourceId: string };
  'navigation:resource-reorder': { oldIndex: number; newIndex: number };
  'navigation:link-clicked': { href: string; label?: string };
  'navigation:router-push': { path: string; reason?: string };
  'navigation:external-navigate': { url: string; resourceId?: string; cancelFallback: () => void };
  'navigation:reference-navigate': { documentId: string };
  'navigation:entity-type-clicked': { entityType: string };

  // Settings events (app-wide)
  'settings:theme-changed': { theme: 'light' | 'dark' | 'system' };
  'settings:line-numbers-toggled': void;
  'settings:locale-changed': { locale: string };

  // ===== API OPERATION EVENTS =====

  // Resource operations
  'resource:archive': void;
  'resource:unarchive': void;
  'resource:clone': void;

  // Job control
  'job:cancel-requested': { jobType: 'detection' | 'generation' };

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

  // Detection operations
  'detection:start': {
    motivation: Motivation;
    options: {
      instructions?: string;
      /** Comment tone */
      tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical' | 'analytical' | 'critical' | 'balanced' | 'constructive';
      density?: number;
      entityTypes?: string[];
      includeDescriptiveReferences?: boolean;
      schemaId?: string;
      categories?: string[];
    };
  };
  'detection:complete': { motivation?: Motivation; resourceUri?: ResourceUri; progress?: DetectionProgress };
  'detection:cancelled': void;
  'detection:dismiss-progress': void;

  // Resource generation operations (unified event-driven flow)
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
  'generation:progress': GenerationProgress;
  'generation:complete': { annotationUri: string; progress: GenerationProgress };
  'generation:failed': { error: Error };
  'generation:modal-open': {
    annotationUri: string;
    resourceUri: string;
    defaultTitle: string;
  };
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
};
