// Graph database interface - all implementations must follow this contract

import {
  Document,
  Selection,
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  DocumentFilter,
  SelectionFilter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateSelectionInput,
  SaveSelectionInput,
  ResolveSelectionInput,
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
  
  // Selection operations (ephemeral or saved)
  createSelection(input: CreateSelectionInput): Promise<Selection>;
  getSelection(id: string): Promise<Selection | null>;
  updateSelection(id: string, updates: Partial<Selection>): Promise<Selection>;
  deleteSelection(id: string): Promise<void>;
  listSelections(filter: SelectionFilter): Promise<{ selections: Selection[]; total: number }>;
  
  // Highlight operations (saved selections)
  saveSelection(input: SaveSelectionInput): Promise<Selection>;
  getHighlights(documentId: string): Promise<Selection[]>;
  
  // Reference operations (resolved selections)
  resolveSelection(input: ResolveSelectionInput): Promise<Selection>;
  getReferences(documentId: string): Promise<Selection[]>;
  getEntityReferences(documentId: string, entityTypes?: string[]): Promise<Selection[]>;
  
  // Relationship queries
  getDocumentSelections(documentId: string): Promise<Selection[]>;
  getDocumentReferencedBy(documentId: string): Promise<Selection[]>;
  
  // Graph traversal
  getDocumentConnections(documentId: string): Promise<GraphConnection[]>;
  findPath(fromDocumentId: string, toDocumentId: string, maxDepth?: number): Promise<GraphPath[]>;
  
  // Analytics
  getEntityTypeStats(): Promise<EntityTypeStats[]>;
  getStats(): Promise<{
    documentCount: number;
    selectionCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }>;
  
  // Bulk operations
  createSelections(inputs: CreateSelectionInput[]): Promise<Selection[]>;
  saveSelections(inputs: SaveSelectionInput[]): Promise<Selection[]>;
  resolveSelections(inputs: ResolveSelectionInput[]): Promise<Selection[]>;
  
  // Auto-detection
  detectSelections(documentId: string): Promise<Selection[]>;
  
  // Utility
  generateId(): string;
  clearDatabase(): Promise<void>; // For testing
}