/**
 * Centralized annotation styles for highlights and references
 * These styles are used across the application for consistent appearance
 */

export const annotationStyles = {
  // Highlight annotation style - dark yellow with dashed ring
  highlight: {
    className: "rounded px-0.5 cursor-pointer transition-all duration-200 bg-yellow-200 hover:bg-yellow-300 text-gray-900 dark:bg-yellow-900/50 dark:hover:bg-yellow-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-yellow-500/60 dark:outline-offset-1"
  },

  // Reference annotation style (resolved references) - blue text like old-fashioned HTML links
  reference: {
    className: "cursor-pointer transition-all duration-200 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
  },

  // Stub reference annotation style (unresolved references) - red text
  stubReference: {
    className: "cursor-pointer transition-all duration-200 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
  },

  // Helper function to get the appropriate style based on annotation type
  getAnnotationStyle: (annotation: {
    type?: string;
    referenceType?: string;
    entityType?: string;
    entityTypes?: string[];
    referencedDocumentId?: string | null;
  }) => {
    if (annotation.type === 'highlight') {
      return annotationStyles.highlight.className;
    }

    // Check if it's a reference type
    if (annotation.type === 'reference') {
      // Stub reference (no target document)
      if (!annotation.referencedDocumentId) {
        return annotationStyles.stubReference.className;
      }
      // Resolved reference (has target document)
      return annotationStyles.reference.className;
    }

    // Legacy check for referencedDocumentId
    if (annotation.referencedDocumentId) {
      return annotationStyles.reference.className;
    }

    // Default to highlight if type is not specified
    return annotationStyles.highlight.className;
  }
} as const;