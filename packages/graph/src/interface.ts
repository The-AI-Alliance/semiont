// The graph, as a reader of it reads it. Every store answers these.
//
// Nothing here writes. The one writer of the graph is the Weaver, a Python
// service that writes through `semiont_graph` (packages/graph-python).

import type {
  Annotation,
  AnnotationId,
  EntityTypeStats,
  GraphConnection,
  GraphPath,
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
  findPath(fromResourceId: ResourceId, toResourceId: ResourceId, maxDepth?: number): Promise<GraphPath[]>;

  // Analytics
  getEntityTypeStats(): Promise<EntityTypeStats[]>;
  getStats(): Promise<{
    resourceCount: number;
    annotationCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }>;
}
