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
 * Replaces separate highlights, references, assessments, comments, tags props.
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
 * Parameters for unified annotation creation.
 * Works for both text selections and image shapes.
 */
export interface CreateAnnotationParams {
  /** The motivation for creating this annotation */
  motivation: import('@/components/annotation/AnnotateToolbar').SelectionMotivation;

  /** Selector information - either text or SVG */
  selector: {
    /** Selector type */
    type: 'TextQuoteSelector' | 'SvgSelector';

    /** For TextQuoteSelector: the exact text selected */
    exact?: string;

    /** For TextQuoteSelector: context before selection */
    prefix?: string;

    /** For TextQuoteSelector: context after selection */
    suffix?: string;

    /** For TextPositionSelector: start position in document */
    start?: number;

    /** For TextPositionSelector: end position in document */
    end?: number;

    /** For SvgSelector: the SVG shape string */
    value?: string;
  };

  /** Optional position for popup placement (text: near selection, image: shape center) */
  position?: { x: number; y: number };
}

/**
 * Unified creation handler for new annotations.
 * Works for both text and image annotations.
 *
 * Behavior by motivation:
 * - highlighting/assessing: Creates annotation immediately
 * - commenting: Creates annotation, then opens Comment Panel
 * - linking: Shows Quick Reference popup FIRST, creates when user confirms
 */
export interface AnnotationCreationHandler {
  onCreate?: (params: CreateAnnotationParams) => void | Promise<void> | Promise<Annotation | undefined>;
}

/**
 * UI state for annotation toolbar and interactions.
 * Groups multiple UI state props into a single object.
 */
export interface AnnotationUIState {
  /** Currently selected annotation motivation (linking, highlighting, etc.) */
  selectedMotivation: import('@/components/annotation/AnnotateToolbar').SelectionMotivation | null;

  /** Currently selected click mode (detail, follow, delete, jsonld) */
  selectedClick: import('@/components/annotation/AnnotateToolbar').ClickAction;

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

  /** Whether view is in annotate mode or browse mode */
  annotateMode?: boolean;
}
