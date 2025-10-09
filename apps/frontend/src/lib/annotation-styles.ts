/**
 * Centralized annotation styles for highlights and references
 * These styles are used across the application for consistent appearance
 */

import { isHighlight, isReference, type Annotation } from '@semiont/core-types';

export const annotationStyles = {
  // Highlight annotation style - dark yellow with dashed ring
  highlight: {
    className: "rounded px-0.5 cursor-pointer transition-all duration-200 bg-yellow-200 hover:bg-yellow-300 text-gray-900 dark:bg-yellow-900/50 dark:hover:bg-yellow-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-yellow-500/60 dark:outline-offset-1"
  },

  // Reference annotation style (used for all references in AnnotateView) - dark blue with dashed ring
  reference: {
    className: "rounded px-0.5 cursor-pointer transition-all duration-200 bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 text-gray-900 dark:from-blue-900/50 dark:to-cyan-900/50 dark:hover:from-blue-900/60 dark:hover:to-cyan-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-cyan-500/60 dark:outline-offset-1"
  },

  // Legacy aliases for backward compatibility
  entityReference: {
    className: "rounded px-0.5 cursor-pointer transition-all duration-200 bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 text-gray-900 dark:from-blue-900/50 dark:to-cyan-900/50 dark:hover:from-blue-900/60 dark:hover:to-cyan-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-cyan-500/60 dark:outline-offset-1"
  },
  documentReference: {
    className: "rounded px-0.5 cursor-pointer transition-all duration-200 bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 text-gray-900 dark:from-blue-900/50 dark:to-cyan-900/50 dark:hover:from-blue-900/60 dark:hover:to-cyan-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-cyan-500/60 dark:outline-offset-1"
  },

  // Helper function to get the appropriate style based on annotation type
  // Used by CodeMirrorRenderer (AnnotateView) - returns gradient backgrounds for all references
  getAnnotationStyle: (annotation: Partial<Annotation>) => {
    // Use W3C-compliant helper functions to determine annotation type
    if (isHighlight(annotation as Annotation)) {
      return annotationStyles.highlight.className;
    }

    if (isReference(annotation as Annotation)) {
      return annotationStyles.reference.className;
    }

    // Default to highlight if type is not specified
    return annotationStyles.highlight.className;
  },

  // Styles for annotation tags/badges - also more visible in dark mode
  tags: {
    entity: "text-xs px-2 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-500/30 dark:text-blue-200 dark:ring-1 dark:ring-blue-400 rounded",
    reference: "text-xs px-2 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-500/30 dark:text-blue-200 dark:ring-1 dark:ring-blue-400 rounded",
  }
} as const;