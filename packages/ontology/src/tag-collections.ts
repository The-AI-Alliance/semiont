/**
 * Tag Collections Management
 *
 * Stores entity types in the graph database as append-only collections.
 * Provides interface for graph database implementations to manage entity type collections.
 */

export interface TagCollection {
  id: string;
  collectionType: 'entity-types';
  tags: string[];
  created: Date;
  updatedAt: Date;
}

export interface TagCollectionOperations {
  /**
   * Get or create collections with auto-seeding
   */
  getEntityTypes(): Promise<string[]>;

  /**
   * Append new tag (no duplicates)
   */
  addEntityType(tag: string): Promise<void>;

  /**
   * Bulk append tags
   */
  addEntityTypes(tags: string[]): Promise<void>;

  /**
   * Check if collections exist
   */
  hasEntityTypesCollection(): Promise<boolean>;

  /**
   * Initialize collections with seed data if they don't exist
   */
  initializeCollections(): Promise<void>;
}
