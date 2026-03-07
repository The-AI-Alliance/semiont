/**
 * Resource creation methods - How resources are created in the system
 */

/**
 * Enumeration of all possible resource creation methods
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
 * Type for resource creation methods
 */
export type CreationMethod = typeof CREATION_METHODS[keyof typeof CREATION_METHODS];