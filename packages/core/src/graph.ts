/**
 * Graph types - Models for graph connections and relationships
 */

import type { components } from '@semiont/api-client';

// Import OpenAPI types
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

/**
 * Represents a connection between resources through annotations
 */
export interface GraphConnection {
  targetDocument: ResourceDescriptor;
  annotations: Annotation[];
  relationshipType?: string;
  bidirectional: boolean;
}

/**
 * Represents a path through the graph
 */
export interface GraphPath {
  documents: ResourceDescriptor[];
  annotations: Annotation[];
}

/**
 * Statistics about entity types in the graph
 */
export interface EntityTypeStats {
  type: string;
  count: number;
}