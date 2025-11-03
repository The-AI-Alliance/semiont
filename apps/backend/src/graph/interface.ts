// Graph database interface - all implementations must follow this contract

import type { components } from '@semiont/api-client';
import type {
  AnnotationCategory,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceFilter,
  UpdateResourceInput,
  CreateAnnotationInternal,
  ResourceId,
  ResourceUri,
  AnnotationId,
  AnnotationUri,
} from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

export interface GraphDatabase {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Resource operations
  // Accepts W3C ResourceDescriptor directly - GraphDB stores W3C compliant resources
  createResource(resource: ResourceDescriptor): Promise<ResourceDescriptor>;
  getResource(id: ResourceUri): Promise<ResourceDescriptor | null>;
  updateResource(id: ResourceUri, input: UpdateResourceInput): Promise<ResourceDescriptor>;
  deleteResource(id: ResourceUri): Promise<void>;
  listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }>;
  searchResources(query: string, limit?: number): Promise<ResourceDescriptor[]>;

  // Annotation operations
  createAnnotation(input: CreateAnnotationInternal): Promise<Annotation>;
  getAnnotation(id: AnnotationUri): Promise<Annotation | null>;
  updateAnnotation(id: AnnotationUri, updates: Partial<Annotation>): Promise<Annotation>;
  deleteAnnotation(id: AnnotationUri): Promise<void>;
  listAnnotations(filter: { resourceId?: ResourceId; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }>;

  // Highlight operations
  getHighlights(resourceId: ResourceId): Promise<Annotation[]>;

  // Reference operations
  resolveReference(annotationId: AnnotationId, source: string): Promise<Annotation>;
  getReferences(resourceId: ResourceId): Promise<Annotation[]>;
  getEntityReferences(resourceId: ResourceId, entityTypes?: string[]): Promise<Annotation[]>;

  // Relationship queries
  getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]>;
  getResourceReferencedBy(resourceId: ResourceId): Promise<Annotation[]>;

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
  createAnnotations(inputs: CreateAnnotationInternal[]): Promise<Annotation[]>;
  resolveReferences(inputs: { annotationId: AnnotationId; source: string }[]): Promise<Annotation[]>;

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