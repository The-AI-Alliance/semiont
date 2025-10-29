// Graph database interface - all implementations must follow this contract

import type { components } from '@semiont/api-client';
import type {
  AnnotationCategory,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceFilter,
  UpdateDocumentInput,
  CreateAnnotationInternal,
} from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Annotation = components['schemas']['Annotation'];

export interface GraphDatabase {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Document operations
  // Accepts W3C ResourceDescriptor directly - GraphDB stores W3C compliant documents
  createDocument(document: ResourceDescriptor): Promise<ResourceDescriptor>;
  getDocument(id: string): Promise<ResourceDescriptor | null>;
  updateDocument(id: string, input: UpdateDocumentInput): Promise<ResourceDescriptor>;
  deleteDocument(id: string): Promise<void>;
  listDocuments(filter: ResourceFilter): Promise<{ documents: ResourceDescriptor[]; total: number }>;
  searchDocuments(query: string, limit?: number): Promise<ResourceDescriptor[]>;
  
  // Annotation operations
  createAnnotation(input: CreateAnnotationInternal): Promise<Annotation>;
  getAnnotation(id: string): Promise<Annotation | null>;
  updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation>;
  deleteAnnotation(id: string): Promise<void>;
  listAnnotations(filter: { documentId?: string; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }>;

  // Highlight operations
  getHighlights(documentId: string): Promise<Annotation[]>;

  // Reference operations
  resolveReference(annotationId: string, source: string): Promise<Annotation>;
  getReferences(documentId: string): Promise<Annotation[]>;
  getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Annotation[]>;

  // Relationship queries
  getDocumentAnnotations(documentId: string): Promise<Annotation[]>;
  getDocumentReferencedBy(documentId: string): Promise<Annotation[]>;
  
  // Graph traversal
  getDocumentConnections(documentId: string): Promise<GraphConnection[]>;
  findPath(fromDocumentId: string, toDocumentId: string, maxDepth?: number): Promise<GraphPath[]>;
  
  // Analytics
  getEntityTypeStats(): Promise<EntityTypeStats[]>;
  getStats(): Promise<{
    documentCount: number;
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
  detectAnnotations(documentId: string): Promise<Annotation[]>;
  
  // Tag Collections
  getEntityTypes(): Promise<string[]>;
  addEntityType(tag: string): Promise<void>;
  addEntityTypes(tags: string[]): Promise<void>;
  
  // Utility
  generateId(): string;
  clearDatabase(): Promise<void>; // For testing
}