// Graph database types and interfaces

export interface Document {
  id: string;
  name: string;
  entityTypes: string[];
  contentType: string;
  storageUrl: string;  // Path to content in filesystem
  metadata: Record<string, any>;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Reference {
  id: string;
  documentId: string;
  referenceType: string;  // 'text_span', 'ast_node', 'image_region', 'audio_segment'
  referenceData: any;     // Type-specific data
  resolvedDocumentId?: string;
  provisional: boolean;
  confidence?: number;
  metadata?: Record<string, any>;
  resolvedBy?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphConnection {
  targetDocument: Document;
  references: Reference[];
  relationshipType?: string;
  bidirectional: boolean;
}

export interface GraphPath {
  documents: Document[];
  references: Reference[];
}

export interface EntityTypeStats {
  type: string;
  count: number;
}

export interface DocumentFilter {
  entityTypes?: string[];
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ReferenceFilter {
  documentId?: string;
  resolvedDocumentId?: string;
  provisional?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateDocumentInput {
  name: string;
  entityTypes?: string[];
  content: string;
  contentType: string;
  metadata?: Record<string, any>;
  createdBy?: string;
}

export interface UpdateDocumentInput {
  name?: string;
  entityTypes?: string[];
  metadata?: Record<string, any>;
  updatedBy?: string;
}

export interface CreateReferenceInput {
  documentId: string;
  referenceType: string;
  referenceData: any;
  resolvedDocumentId?: string;
  provisional?: boolean;
  confidence?: number;
  metadata?: Record<string, any>;
  resolvedBy?: string;
}

export interface ResolveReferenceInput {
  referenceId: string;
  documentId: string;
  provisional?: boolean;
  confidence?: number;
  resolvedBy?: string;
  metadata?: Record<string, any>;
}