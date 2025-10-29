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
  getResource(id: string): Promise<ResourceDescriptor | null>;
  updateResource(id: string, input: UpdateResourceInput): Promise<ResourceDescriptor>;
  deleteResource(id: string): Promise<void>;
  listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }>;
  searchResources(query: string, limit?: number): Promise<ResourceDescriptor[]>;
  
  // Annotation operations
  createAnnotation(input: CreateAnnotationInternal): Promise<Annotation>;
  getAnnotation(id: string): Promise<Annotation | null>;
  updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation>;
  deleteAnnotation(id: string): Promise<void>;
  listAnnotations(filter: { resourceId?: string; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }>;

  // Highlight operations
  getHighlights(resourceId: string): Promise<Annotation[]>;

  // Reference operations
  resolveReference(annotationId: string, source: string): Promise<Annotation>;
  getReferences(resourceId: string): Promise<Annotation[]>;
  getEntityReferences(resourceId: string, entityTypes?: string[]): Promise<Annotation[]>;

  // Relationship queries
  getResourceAnnotations(resourceId: string): Promise<Annotation[]>;
  getResourceReferencedBy(resourceId: string): Promise<Annotation[]>;
  
  // Graph traversal
  getResourceConnections(resourceId: string): Promise<GraphConnection[]>;
  findPath(fromResourceId: string, toResourceId: string, maxDepth?: number): Promise<GraphPath[]>;
  
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
  resolveReferences(inputs: { annotationId: string; source: string }[]): Promise<Annotation[]>;

  // Auto-detection
  detectAnnotations(resourceId: string): Promise<Annotation[]>;
  
  // Tag Collections
  getEntityTypes(): Promise<string[]>;
  addEntityType(tag: string): Promise<void>;
  addEntityTypes(tags: string[]): Promise<void>;
  
  // Utility
  generateId(): string;
  clearDatabase(): Promise<void>; // For testing
}