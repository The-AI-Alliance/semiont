// Graph database interface - all implementations must follow this contract

import {
  Document,
  Annotation,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateAnnotationRequest,
} from '@semiont/core-types';

export interface GraphDatabase {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Document operations
  // Note: id is required because GraphDB is Layer 4 (downstream of Layer 1 which generates content-addressed IDs)
  createDocument(input: CreateDocumentInput & { id: string }): Promise<Document>;
  getDocument(id: string): Promise<Document | null>;
  updateDocument(id: string, input: UpdateDocumentInput): Promise<Document>;
  deleteDocument(id: string): Promise<void>;
  listDocuments(filter: DocumentFilter): Promise<{ documents: Document[]; total: number }>;
  searchDocuments(query: string, limit?: number): Promise<Document[]>;
  
  // Annotation operations
  createAnnotation(input: CreateAnnotationRequest): Promise<Annotation>;
  getAnnotation(id: string): Promise<Annotation | null>;
  updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation>;
  deleteAnnotation(id: string): Promise<void>;
  listAnnotations(filter: { documentId?: string; type?: 'highlight' | 'reference' }): Promise<{ annotations: Annotation[]; total: number }>;

  // Highlight operations
  getHighlights(documentId: string): Promise<Annotation[]>;

  // Reference operations
  resolveReference(annotationId: string, referencedDocumentId: string): Promise<Annotation>;
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
  createAnnotations(inputs: CreateAnnotationRequest[]): Promise<Annotation[]>;
  resolveReferences(inputs: { annotationId: string; referencedDocumentId: string }[]): Promise<Annotation[]>;

  // Auto-detection
  detectAnnotations(documentId: string): Promise<Annotation[]>;
  
  // Tag Collections
  getEntityTypes(): Promise<string[]>;
  getReferenceTypes(): Promise<string[]>;
  addEntityType(tag: string): Promise<void>;
  addReferenceType(tag: string): Promise<void>;
  addEntityTypes(tags: string[]): Promise<void>;
  addReferenceTypes(tags: string[]): Promise<void>;
  
  // Utility
  generateId(): string;
  clearDatabase(): Promise<void>; // For testing
}