/**
 * Graph types - Models for graph connections and relationships
 */

import type { components } from './types';

// Import OpenAPI types
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

/**
 * Represents a connection between resources through annotations
 */
export interface GraphConnection {
  targetResource: ResourceDescriptor;
  annotations: Annotation[];
  relationshipType?: string;
  bidirectional: boolean;
}

/**
 * Represents a path through the graph
 */
export interface GraphPath {
  resources: ResourceDescriptor[];
  annotations: Annotation[];
}

/**
 * Statistics about entity types in the graph
 */
export interface EntityTypeStats {
  type: string;
  count: number;
}