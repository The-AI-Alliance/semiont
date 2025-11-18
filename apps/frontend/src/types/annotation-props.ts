/**
 * Type definitions for grouped annotation component props.
 *
 * These types help reduce props explosion by grouping related concerns:
 * - Annotations collection (4 props → 1)
 * - Event handlers (6+ props → grouped)
 * - UI state (multiple props → 1)
 */

import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

/**
 * Collection of all annotation types for a resource.
 * Replaces separate highlights, references, assessments, comments props.
 */
export interface AnnotationsCollection {
  highlights: Annotation[];
  references: Annotation[];
  assessments: Annotation[];
  comments: Annotation[];
}

/**
 * Event handlers for annotation interactions.
 * Groups multiple click and hover handlers into a single interface.
 */
export interface AnnotationHandlers {
  /** Unified click handler - routes based on annotation type and current mode */
  onClick?: (annotation: Annotation, event?: React.MouseEvent) => void;

  /** Unified hover handler for all annotation types */
  onHover?: (annotationId: string | null) => void;

  /** Hover handler specifically for comment panel highlighting */
  onCommentHover?: (commentId: string | null) => void;
}

/**
 * Creation handlers for new annotations.
 * Groups multiple onCreate handlers by motivation type.
 */
export interface AnnotationCreationHandlers {
  onCreateHighlight?: (exact: string, position: { start: number; end: number }, context?: { prefix?: string; suffix?: string }) => void;
  onCreateAssessment?: (exact: string, position: { start: number; end: number }, context?: { prefix?: string; suffix?: string }) => void;
  onCreateComment?: (exact: string, position: { start: number; end: number }, context?: { prefix?: string; suffix?: string }) => void;
  onCreateReference?: (exact: string, position: { start: number; end: number }, popupPosition: { x: number; y: number }, context?: { prefix?: string; suffix?: string }) => void;
}

/**
 * Panel-specific click handlers.
 * Used for opening side panels for comments and references.
 */
export interface AnnotationPanelHandlers {
  onCommentClick?: (commentId: string) => void;
  onReferenceClick?: (referenceId: string) => void;
}

/**
 * UI state for annotation toolbar and interactions.
 * Groups multiple UI state props into a single object.
 */
export interface AnnotationUIState {
  /** Currently selected annotation motivation (linking, highlighting, etc.) */
  selectedSelection: import('@/components/annotation/AnnotateToolbar').SelectionMotivation | null;

  /** Currently selected click mode (detail, follow, delete, jsonld) */
  selectedClick: import('@/components/annotation/AnnotateToolbar').ClickMotivation;

  /** Currently selected shape for image annotations */
  selectedShape: import('@/components/annotation/AnnotateToolbar').ShapeType;

  /** ID of currently hovered annotation (optional - only set when hovering) */
  hoveredAnnotationId?: string | null;

  /** ID of currently hovered comment for panel highlighting (optional - only set when hovering) */
  hoveredCommentId?: string | null;

  /** ID of annotation to scroll to (optional - only set when scrolling needed) */
  scrollToAnnotationId?: string | null;
}

/**
 * Configuration options for annotation views.
 * Groups feature flags and settings.
 */
export interface AnnotationConfig {
  /** Whether content is editable */
  editable?: boolean;

  /** Whether to show annotation widgets (entity types, reference buttons) */
  enableWidgets?: boolean;

  /** Whether to show line numbers in code view */
  showLineNumbers?: boolean;

  /** Whether view is in curation mode (annotate) or browse mode */
  curationMode?: boolean;
}
