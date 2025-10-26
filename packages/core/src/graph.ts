/**
 * Graph types - Models for graph connections and relationships
 */

import type { components } from '@semiont/api-client';

// Import OpenAPI types
type Document = components['schemas']['Document'];
type Annotation = components['schemas']['Annotation'];

/**
 * Represents a connection between documents through annotations
 */
export interface GraphConnection {
  targetDocument: Document;
  annotations: Annotation[];
  relationshipType?: string;
  bidirectional: boolean;
}

/**
 * Represents a path through the graph
 */
export interface GraphPath {
  documents: Document[];
  annotations: Annotation[];
}

/**
 * Statistics about entity types in the graph
 */
export interface EntityTypeStats {
  type: string;
  count: number;
}