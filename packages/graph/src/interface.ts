// Graph database interface - all implementations must follow this contract

import type {
  Annotation,
  AnnotationCategory,
  AnnotationId,
  CreateAnnotationInternal,
  EntityTypeStats,
  GraphConnection,
  GraphPath,
  ResourceDescriptor,
  ResourceFilter,
  ResourceId,
  UpdateResourceInput,
} from '@semiont/core';

const MUTABLE_RESOURCE_FACETS = new Set<string>(['archived', 'entityTypes']);

/**
 * Resources are immutable apart from two facets: archival state, and entity
 * tags (mutable since the controlled-vocabulary decision — the Weaver folds
 * `mark:archived`/`mark:unarchived` and `mark:entity-tag-added`/`-removed`
 * through `updateResource`). Every implementation validates its input with
 * this one guard so the mutability contract cannot drift per backend.
 */
export function assertMutableResourceUpdate(input: UpdateResourceInput): void {
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((k) => !MUTABLE_RESOURCE_FACETS.has(k))) {
    throw new Error('Resources are immutable apart from archival state and entity tags.');
  }
}

export interface GraphDatabase {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Resource operations
  // Accepts W3C ResourceDescriptor directly - GraphDB stores W3C compliant resources
  createResource(resource: ResourceDescriptor): Promise<ResourceDescriptor>;
  getResource(id: ResourceId): Promise<ResourceDescriptor | null>;
  updateResource(id: ResourceId, input: UpdateResourceInput): Promise<ResourceDescriptor>;
  deleteResource(id: ResourceId): Promise<void>;
  listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }>;
  searchResources(query: string, limit?: number): Promise<ResourceDescriptor[]>;

  // Annotation operations
  createAnnotation(input: CreateAnnotationInternal): Promise<Annotation>;
  getAnnotation(id: AnnotationId): Promise<Annotation | null>;
  updateAnnotation(id: AnnotationId, updates: Partial<Annotation>): Promise<Annotation>;
  deleteAnnotation(id: AnnotationId): Promise<void>;
  listAnnotations(filter: { resourceId?: ResourceId; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }>;

  // Highlight operations
  getHighlights(resourceId: ResourceId): Promise<Annotation[]>;

  // Reference operations
  resolveReference(annotationId: AnnotationId, source: ResourceId): Promise<Annotation>;
  getReferences(resourceId: ResourceId): Promise<Annotation[]>;
  getEntityReferences(resourceId: ResourceId, entityTypes?: string[]): Promise<Annotation[]>;

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
  
  // Bulk operations
  batchCreateResources(resources: ResourceDescriptor[]): Promise<ResourceDescriptor[]>;
  createAnnotations(inputs: CreateAnnotationInternal[]): Promise<Annotation[]>;
  resolveReferences(inputs: { annotationId: AnnotationId; source: ResourceId }[]): Promise<Annotation[]>;

  // Auto-detection
  detectAnnotations(resourceId: ResourceId): Promise<Annotation[]>;
  
  // Tag Collections
  getEntityTypes(): Promise<string[]>;
  addEntityType(tag: string): Promise<void>;
  addEntityTypes(tags: string[]): Promise<void>;
  
  // Utility
  generateId(): string;
  clearDatabase(): Promise<void>; // For testing
}