// The graph, as a reader of it reads it. Every store answers these.
//
// Nothing here writes. The one writer of the graph is the Weaver, a Python
// service that writes through `semiont_graph` (packages/graph-python).

import type {
  Annotation,
  AnnotationId,
  EntityTypeStats,
  GraphConnection,
  ResourceDescriptor,
  ResourceFilter,
  ResourceId,
} from '@semiont/core';

export interface GraphDatabase {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Resources
  getResource(id: ResourceId): Promise<ResourceDescriptor | null>;
  listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }>;

  // Annotations
  getAnnotation(id: AnnotationId): Promise<Annotation | null>;

  // Relationship queries
  getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]>;
  getResourceReferencedBy(resourceId: ResourceId, motivation?: string): Promise<Annotation[]>;

  // Graph traversal
  getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]>;

  // Analytics
  getEntityTypeStats(): Promise<EntityTypeStats[]>;
}
