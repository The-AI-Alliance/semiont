// Tag Collections Management
// Stores entity types in the graph database as append-only collections

export interface TagCollection {
  id: string;
  collectionType: 'entity-types';
  tags: string[];
  created: Date;
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

export interface TagCollectionOperations {
  // Get or create collections with auto-seeding
  getEntityTypes(): Promise<string[]>;

  // Append new tags (no duplicates)
  addEntityType(tag: string): Promise<void>;

  // Bulk append
  addEntityTypes(tags: string[]): Promise<void>;

  // Check if collections exist
  hasEntityTypesCollection(): Promise<boolean>;

  // Initialize collections with seed data if they don't exist
  initializeCollections(): Promise<void>;
}