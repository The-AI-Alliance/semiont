/**
 * Reference tags - Semantic relationship types between selections and documents
 */

/**
 * Common reference tag types for semantic relationships
 */
export const REFERENCE_TAGS = {
  // Definitional
  DEFINES: 'defines',
  DEFINED_BY: 'defined-by',

  // Citation
  CITES: 'cites',
  CITED_BY: 'cited-by',

  // Support/Opposition
  SUPPORTS: 'supports',
  REFUTES: 'refutes',
  CONTRADICTS: 'contradicts',

  // Relationship
  MENTIONS: 'mentions',
  DESCRIBES: 'describes',
  EXPLAINS: 'explains',
  SUMMARIZES: 'summarizes',
  ELABORATES: 'elaborates',

  // Structural
  CONTAINS: 'contains',
  PART_OF: 'part-of',
  FOLLOWS: 'follows',
  PRECEDES: 'precedes',

  // Comparison
  COMPARES_TO: 'compares-to',
  CONTRASTS_WITH: 'contrasts-with',
  SIMILAR_TO: 'similar-to',

  // Dependency
  DEPENDS_ON: 'depends-on',
  REQUIRED_BY: 'required-by',
  IMPORTS: 'imports',
  EXPORTS: 'exports',

  // Versioning
  UPDATES: 'updates',
  REPLACES: 'replaces',
  DEPRECATED_BY: 'deprecated-by',
} as const;

/**
 * Type for reference tags - allows predefined tags or custom strings
 */
export type ReferenceTag = typeof REFERENCE_TAGS[keyof typeof REFERENCE_TAGS] | string;