/**
 * Document creation methods - How documents are created in the system
 */

/**
 * Enumeration of all possible document creation methods
 */
export const CREATION_METHODS = {
  API: 'api',
  UPLOAD: 'upload',
  UI: 'ui',
  REFERENCE: 'reference',
  CLONE: 'clone',
  GENERATED: 'generated',
} as const;

/**
 * Type for document creation methods
 */
export type CreationMethod = typeof CREATION_METHODS[keyof typeof CREATION_METHODS];