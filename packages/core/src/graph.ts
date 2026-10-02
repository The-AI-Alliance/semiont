/**
 * Graph types - Models for graph connections and relationships
 */

import type { components } from './types';
import type { Annotation } from './annotation-types';

/** A resource's description, as the spec states it: its `@id` is the resource's `ResourceId`. */
export type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

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