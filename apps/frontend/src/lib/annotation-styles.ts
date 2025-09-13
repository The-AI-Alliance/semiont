/**
 * Centralized annotation styles for highlights and references
 * These styles are used across the application for consistent appearance
 */

export const annotationStyles = {
  // Highlight annotation style - dark yellow with dashed ring
  highlight: {
    className: "rounded px-0.5 cursor-pointer transition-all duration-200 bg-yellow-200 hover:bg-yellow-300 text-gray-900 dark:bg-yellow-900/50 dark:hover:bg-yellow-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-yellow-500/60 dark:outline-offset-1"
  },
  
  // Entity reference annotation style - dark purple with dashed ring
  entityReference: {
    className: "rounded px-0.5 cursor-pointer transition-all duration-200 bg-purple-200 hover:bg-purple-300 text-gray-900 dark:bg-purple-900/50 dark:hover:bg-purple-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-purple-500/60 dark:outline-offset-1"
  },
  
  // Document reference annotation style - dark blue with dashed ring
  documentReference: {
    className: "rounded px-0.5 cursor-pointer transition-all duration-200 bg-gradient-to-r from-cyan-200 to-blue-200 hover:from-cyan-300 hover:to-blue-300 text-gray-900 dark:from-blue-900/50 dark:to-cyan-900/50 dark:hover:from-blue-900/60 dark:hover:to-cyan-900/60 dark:text-white dark:outline dark:outline-2 dark:outline-dashed dark:outline-cyan-500/60 dark:outline-offset-1"
  },
  
  // Helper function to get the appropriate style based on annotation type
  getAnnotationStyle: (annotation: {
    type?: string;
    referenceType?: string;
    entityType?: string;
    entityTypes?: string[];
  }) => {
    if (annotation.type === 'highlight') {
      return annotationStyles.highlight.className;
    }
    
    // Check for entity references - they have entityTypes array or entityType field
    if (annotation.referenceType === 'entity' || 
        annotation.entityTypes?.length || 
        annotation.entityType) {
      return annotationStyles.entityReference.className;
    }
    
    // Default to document reference style
    return annotationStyles.documentReference.className;
  },
  
  // Styles for annotation tags/badges - also more visible in dark mode
  tags: {
    entity: "text-xs px-2 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-500/30 dark:text-purple-200 dark:ring-1 dark:ring-purple-400 rounded",
    reference: "text-xs px-2 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-500/30 dark:text-blue-200 dark:ring-1 dark:ring-blue-400 rounded",
  }
} as const;