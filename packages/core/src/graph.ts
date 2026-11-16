/**
 * Graph types - Models for graph connections and relationships
 */

import type { components } from './types';
import type { ResourceId } from './identifiers';
import type { Annotation } from './annotation-types';

type RawResourceDescriptor = components['schemas']['ResourceDescriptor'];

/**
 * Domain-level ResourceDescriptor type. Same shape as the OpenAPI-generated
 * `components['schemas']['ResourceDescriptor']`, but with a branded `ResourceId`
 * for the `@id` field.
 *
 * Implemented by intersection (not `Omit`) because the generated raw type
 * ends in `& { [key: string]: unknown }` — `Omit` on an intersection with
 * an index signature drops almost all named fields.
 */
export type ResourceDescriptor = RawResourceDescriptor & { '@id': ResourceId };

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