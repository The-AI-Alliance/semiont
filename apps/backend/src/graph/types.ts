// Graph database types and interfaces

export interface Document {
  id: string;
  name: string;
  entityTypes: string[];
  contentType: string;
  storageUrl: string;  // Path to content in filesystem
  metadata: Record<string, any>;
  archived: boolean;  // Whether the document is archived (read-only)
  
  // Audit fields (backend-controlled)
  createdBy?: string;  // Set from auth context by backend
  updatedBy?: string;  // Set from auth context by backend
  createdAt: Date;  // Set by backend on creation
  updatedAt: Date;  // Set by backend on update
  
  // Provenance tracking (backend-controlled with optional client context)
  creationMethod?: 'reference' | 'upload' | 'ui' | 'api' | 'clone';  // How document was created (defaults to 'api')
  contentChecksum?: string;  // SHA-256 hash calculated by backend for integrity
  sourceSelectionId?: string;  // If created from reference, the selection that triggered it
  sourceDocumentId?: string;  // If created from reference/clone, the source document
}

// Base selection type - represents any selection within a document
export interface Selection {
  id: string;
  documentId: string;
  selectionType: string;  // 'text_span', 'ast_node', 'image_region', 'audio_segment'
  selectionData: any;     // Type-specific data (offset, length, coordinates, etc.)
  
  // If resolved to a document, it becomes a reference
  resolvedDocumentId?: string;
  resolvedAt?: Date;
  resolvedBy?: string;
  
  // Reference tags - semantic relationship types
  referenceTags?: string[];  // e.g., ['defines', 'mentions', 'cites', 'refutes', 'supports']
  
  // If resolved document has entity types and selection specifies them
  entityTypes?: string[];  // Specific entity types this selection references
  
  // Provisional selections are auto-detected
  provisional: boolean;
  confidence?: number;
  
  metadata?: Record<string, any>;
  createdBy?: string;  // User who created the selection
  createdAt: Date;
  updatedAt: Date;
}

// Common reference tag types (can be extended)
export const REFERENCE_TAGS = {
  // Definitional
  DEFINES: 'defines',
  DEFINED_BY: 'defined-by',
  
  // Citation
  CITES: 'cites',
  CITED_BY: 'cited-by',
  
  // Support/Opposition
  SUPPORTS: 'supports',
  REFUTES: 'refutes',
  CONTRADICTS: 'contradicts',
  
  // Relationship
  MENTIONS: 'mentions',
  DESCRIBES: 'describes',
  EXPLAINS: 'explains',
  SUMMARIZES: 'summarizes',
  ELABORATES: 'elaborates',
  
  // Structural
  CONTAINS: 'contains',
  PART_OF: 'part-of',
  FOLLOWS: 'follows',
  PRECEDES: 'precedes',
  
  // Comparison
  COMPARES_TO: 'compares-to',
  CONTRASTS_WITH: 'contrasts-with',
  SIMILAR_TO: 'similar-to',
  
  // Dependency
  DEPENDS_ON: 'depends-on',
  REQUIRED_BY: 'required-by',
  IMPORTS: 'imports',
  EXPORTS: 'exports',
  
  // Versioning
  UPDATES: 'updates',
  REPLACES: 'replaces',
  DEPRECATED_BY: 'deprecated-by',
} as const;

export type ReferenceTag = typeof REFERENCE_TAGS[keyof typeof REFERENCE_TAGS] | string;

// Type guards and computed properties
export function isHighlight(selection: Selection): boolean {
  // Highlight = no resolvedDocumentId field at all
  return !('resolvedDocumentId' in selection);
}

export function isReference(selection: Selection): boolean {
  // Reference = has resolvedDocumentId field (even if null for stubs)
  return 'resolvedDocumentId' in selection;
}

export function isEntityReference(selection: Selection): boolean {
  return !!selection.resolvedDocumentId && !!selection.entityTypes && selection.entityTypes.length > 0;
}

export function hasReferenceTags(selection: Selection): boolean {
  return !!selection.referenceTags && selection.referenceTags.length > 0;
}

export interface GraphConnection {
  targetDocument: Document;
  selections: Selection[];
  relationshipType?: string;
  bidirectional: boolean;
}

export interface GraphPath {
  documents: Document[];
  selections: Selection[];
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

export interface SelectionFilter {
  documentId?: string;
  resolvedDocumentId?: string;
  provisional?: boolean;
  resolved?: boolean;  // Filter for references
  hasEntityTypes?: boolean;  // Filter for entity references
  referenceTags?: string[];  // Filter by reference tags
  limit?: number;
  offset?: number;
}

export interface CreateDocumentInput {
  name: string;
  entityTypes?: string[];
  content: string;
  contentType: string;
  metadata?: Record<string, any>;
  createdBy?: string;  // Should be set by backend from auth context
  
  // Provenance tracking (only context fields, not derived fields)
  creationMethod?: 'reference' | 'upload' | 'ui' | 'api' | 'clone';  // Defaults to 'api' if not specified
  sourceSelectionId?: string;  // For reference-created documents
  sourceDocumentId?: string;  // For reference-created documents
  contentChecksum?: string;  // SHA-256 hash calculated by backend
  // Note: createdAt is set by backend
}

export interface UpdateDocumentInput {
  name?: string;
  entityTypes?: string[];
  metadata?: Record<string, any>;
  archived?: boolean;
  updatedBy?: string;
}

export interface CreateSelectionInput {
  documentId: string;
  selectionType: string;
  selectionData: any;
  
  createdBy?: string;
  
  // Optional - makes it a reference
  resolvedDocumentId?: string;
  resolvedBy?: string;
  
  // Optional - semantic relationship tags
  referenceTags?: string[];
  
  // Optional - makes it an entity reference
  entityTypes?: string[];
  
  provisional?: boolean;
  confidence?: number;
  metadata?: Record<string, any>;
}

// SaveSelectionInput removed - selections don't have a separate "save" operation
// They are either highlights (no resolvedDocumentId) or references (has resolvedDocumentId)

export interface ResolveSelectionInput {
  selectionId: string;
  documentId: string;
  referenceTags?: string[];  // Semantic relationship tags
  entityTypes?: string[];  // Optionally specify which entity types are being referenced
  provisional?: boolean;
  confidence?: number;
  resolvedBy?: string;
  metadata?: Record<string, any>;
}