/**
 * Centralized annotation type registry
 *
 * Single source of truth for W3C annotation motivation metadata including:
 * - Visual styling (CSS classes)
 * - Behavior flags (clickable, hover, side panel)
 * - Type guards (motivation matching)
 * - Accessibility (screen reader announcements)
 *
 * Per CLAUDE.md: This is the ONLY place to define annotation type metadata.
 * No aliasing, wrappers, or compatibility layers elsewhere.
 */

import type { components } from '@semiont/api-client';
import { isHighlight, isComment, isReference } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation']; // Already defined in api-client with all 13 W3C motivations!

export interface AnnotationTypeMetadata {
  motivation: Motivation;
  internalType: string;
  displayName: string;
  description: string;

  // Visual styling
  className: string;
  iconEmoji?: string;

  // Behavior flags
  isClickable: boolean;
  hasHoverInteraction: boolean;
  hasSidePanel: boolean;

  // Type guard function
  matchesAnnotation: (annotation: Annotation) => boolean;

  // Accessibility
  announceOnCreate: string;
}

export const ANNOTATION_TYPES: Record<string, AnnotationTypeMetadata> = {
  highlight: {
    motivation: 'highlighting',
    internalType: 'highlight',
    displayName: 'Highlight',
    description: 'Mark text for attention',
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-yellow-200 hover:bg-yellow-300 text-gray-900 dark:bg-yellow-900/50 dark:hover:bg-yellow-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-yellow-500/60 dark:outline-offset-1',
    iconEmoji: '🟡',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: false,
    matchesAnnotation: (ann) => isHighlight(ann),
    announceOnCreate: 'Highlight created'
  },

  comment: {
    motivation: 'commenting',
    internalType: 'comment',
    displayName: 'Comment',
    description: 'Add a comment about the text',
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 hover:bg-gray-100 dark:hover:bg-gray-800 outline outline-2 outline-dashed outline-gray-900 dark:outline-gray-100 outline-offset-1',
    iconEmoji: '💬',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann) => isComment(ann),
    announceOnCreate: 'Comment created'
  },

  assessment: {
    motivation: 'assessing',
    internalType: 'assessment',
    displayName: 'Assessment',
    description: 'Provide evaluation or assessment',
    className: 'red-underline cursor-pointer transition-all duration-200 hover:opacity-80',
    iconEmoji: '🔴',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: false,
    matchesAnnotation: (ann) => ann.motivation === 'assessing',
    announceOnCreate: 'Assessment created'
  },

  reference: {
    motivation: 'linking',
    internalType: 'reference',
    displayName: 'Reference',
    description: 'Link to another resource',
    className: 'rounded px-0.5 cursor-pointer transition-all duration-200 bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 text-gray-900 dark:from-blue-900/50 dark:to-cyan-900/50 dark:hover:from-blue-900/60 dark:hover:to-cyan-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-cyan-500/60 dark:outline-offset-1',
    iconEmoji: '🔵',
    isClickable: true,
    hasHoverInteraction: true,
    hasSidePanel: true,
    matchesAnnotation: (ann) => isReference(ann),
    announceOnCreate: 'Reference created'
  }
};

/**
 * Get metadata for an annotation by checking all registered types
 * Returns null if annotation doesn't match any registered type
 */
export function getAnnotationTypeMetadata(annotation: Annotation): AnnotationTypeMetadata | null {
  for (const metadata of Object.values(ANNOTATION_TYPES)) {
    if (metadata.matchesAnnotation(annotation)) {
      return metadata;
    }
  }
  return null;
}

/**
 * Get CSS className for an annotation
 * Falls back to highlight style if no match found
 */
export function getAnnotationClassName(annotation: Annotation): string {
  const metadata = getAnnotationTypeMetadata(annotation);
  return metadata?.className ?? ANNOTATION_TYPES.highlight!.className;
}

/**
 * Get internal type string for an annotation (e.g., 'highlight', 'comment')
 * Falls back to 'highlight' if no match found
 */
export function getAnnotationInternalType(annotation: Annotation): string {
  const metadata = getAnnotationTypeMetadata(annotation);
  return metadata?.internalType ?? 'highlight';
}

/**
 * Group annotations by their internal type
 * Returns a record with keys like 'highlight', 'comment', 'assessment', 'reference'
 * Each value is an array of annotations of that type
 */
export function groupAnnotationsByType(annotations: Annotation[]): Record<string, Annotation[]> {
  const groups: Record<string, Annotation[]> = {};

  // Initialize empty arrays for all registered types
  for (const metadata of Object.values(ANNOTATION_TYPES)) {
    if (metadata) {
      groups[metadata.internalType] = [];
    }
  }

  // Group annotations by type
  for (const ann of annotations) {
    const metadata = getAnnotationTypeMetadata(ann);
    if (metadata) {
      groups[metadata.internalType]!.push(ann);
    }
  }

  return groups;
}
