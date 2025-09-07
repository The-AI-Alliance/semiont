// Graph database interface - all implementations must follow this contract

import {
  Document,
  Reference,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  ReferenceFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateReferenceInput,
  ResolveReferenceInput,
} from './types';

export interface GraphDatabase {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  
  // Document operations
  createDocument(input: CreateDocumentInput): Promise<Document>;
  getDocument(id: string): Promise<Document | null>;
  updateDocument(id: string, input: UpdateDocumentInput): Promise<Document>;
  deleteDocument(id: string): Promise<void>;
  listDocuments(filter: DocumentFilter): Promise<{ documents: Document[]; total: number }>;
  searchDocuments(query: string, limit?: number): Promise<Document[]>;
  
  // Reference operations
  createReference(input: CreateReferenceInput): Promise<Reference>;
  getReference(id: string): Promise<Reference | null>;
  resolveReference(input: ResolveReferenceInput): Promise<Reference>;
  deleteReference(id: string): Promise<void>;
  listReferences(filter: ReferenceFilter): Promise<{ references: Reference[]; total: number }>;
  
  // Relationship queries
  getDocumentReferences(documentId: string): Promise<Reference[]>;
  getDocumentReferencedBy(documentId: string): Promise<Reference[]>;
  
  // Graph traversal
  getDocumentConnections(documentId: string): Promise<GraphConnection[]>;
  findPath(fromDocumentId: string, toDocumentId: string, maxDepth?: number): Promise<GraphPath[]>;
  
  // Analytics
  getEntityTypeStats(): Promise<EntityTypeStats[]>;
  getStats(): Promise<{
    documentCount: number;
    referenceCount: number;
    resolvedReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }>;
  
  // Bulk operations
  createReferences(inputs: CreateReferenceInput[]): Promise<Reference[]>;
  resolveReferences(inputs: ResolveReferenceInput[]): Promise<Reference[]>;
  
  // Utility
  generateId(): string;
  clearDatabase(): Promise<void>; // For testing
}