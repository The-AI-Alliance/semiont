// Tag Collections Management
// Stores entity types and reference types in the graph database as append-only collections

export interface TagCollection {
  id: string;
  collectionType: 'entity-types' | 'reference-types';
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Default seed data for collections
export const DEFAULT_ENTITY_TYPES = [
  'Person',
  'Organization',
  'Location',
  'Event',
  'Concept',
  'Product',
  'Technology',
  'Date',
  'Author'
];

export const DEFAULT_REFERENCE_TYPES = [
  // Definitional
  'defines',
  'defined-by',
  
  // Citation
  'cites',
  'cited-by',
  
  // Support/Opposition
  'supports',
  'refutes',
  'contradicts',
  
  // Relationship
  'mentions',
  'describes',
  'explains',
  'summarizes',
  'elaborates',
  
  // Structural
  'contains',
  'part-of',
  'follows',
  'precedes',
  
  // Comparison
  'compares-to',
  'contrasts-with',
  'similar-to',
  
  // Dependency
  'depends-on',
  'required-by',
  'imports',
  'exports',
  
  // Versioning
  'updates',
  'replaces',
  'deprecated-by',
  
  // Legacy simple types (for backwards compatibility)
  'citation',
  'definition',
  'elaboration',
  'example',
  'related'
];

export interface TagCollectionOperations {
  // Get or create collections with auto-seeding
  getEntityTypes(): Promise<string[]>;
  getReferenceTypes(): Promise<string[]>;
  
  // Append new tags (no duplicates)
  addEntityType(tag: string): Promise<void>;
  addReferenceType(tag: string): Promise<void>;
  
  // Bulk append
  addEntityTypes(tags: string[]): Promise<void>;
  addReferenceTypes(tags: string[]): Promise<void>;
  
  // Check if collections exist
  hasEntityTypesCollection(): Promise<boolean>;
  hasReferenceTypesCollection(): Promise<boolean>;
  
  // Initialize collections with seed data if they don't exist
  initializeCollections(): Promise<void>;
}