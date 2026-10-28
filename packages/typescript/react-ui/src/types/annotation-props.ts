/**
 * Type definitions for grouped annotation component props.
 *
 * Each type gathers one concern into a single prop:
 * - Annotations collection
 * - Event handlers
 * - UI state
 */


import type { Annotation } from '@semiont/core';

/**
 * Collection of all annotation types for a resource.
 */
export interface AnnotationsCollection {
  highlights: Annotation[];
  references: Annotation[];
  assessments: Annotation[];
  comments: Annotation[];
  tags: Annotation[];
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
 * UI state for annotation toolbar and interactions.
 * Groups multiple UI state props into a single object.
 */
export interface AnnotationUIState {
  /** Currently selected annotation motivation (linking, highlighting, etc.) */
  selectedMotivation: import('@semiont/react-ui').SelectionMotivation | null;

  /** Currently selected click mode (detail, follow, delete, jsonld) */
  selectedClick: import('@semiont/react-ui').ClickAction;

  /** Currently selected shape for image annotations */
  selectedShape: import('@semiont/react-ui').ShapeType;

  /** ID of currently hovered annotation (optional - only set when hovering) */
  hoveredAnnotationId?: string | null;

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

  /** Whether view is in annotate mode or browse mode */
  annotateMode?: boolean;
}
