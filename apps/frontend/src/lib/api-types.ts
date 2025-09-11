/**
 * Actual API response types that match what the backend returns
 * These should be kept in sync with the backend schemas
 */

// Backend selection type (what actually comes from the API)
export interface BackendSelection {
  id: string;
  documentId: string;
  selectionType: string;
  selectionData: {
    type: string;
    offset: number;
    length: number;
    text: string;
  };
  
  // Highlight properties
  saved: boolean;
  savedAt?: string;
  savedBy?: string;
  
  // Reference properties (NOTE: Backend uses 'resolved' not 'referenced')
  resolvedDocumentId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  
  // Tags
  referenceTags?: string[];
  entityTypes?: string[];
  
  // Metadata
  provisional?: boolean;
  confidence?: number;
  metadata?: Record<string, any>;
  
  createdAt: string;
  updatedAt: string;
}

// Frontend selection type (what our components expect)
export interface FrontendSelection {
  id: string;
  documentId: string;
  text?: string;
  selectionData: {
    type: string;
    offset: number;
    length: number;
    text: string;
  };
  
  // Use consistent naming for frontend
  referencedDocumentId?: string;
  entityType?: string;
  referenceType?: string;
  
  createdAt?: string;
  updatedAt?: string;
}

// Mapper function to convert backend to frontend format
export function mapBackendToFrontendSelection(backend: BackendSelection): FrontendSelection {
  return {
    id: backend.id,
    documentId: backend.documentId,
    text: backend.selectionData.text,
    selectionData: backend.selectionData,
    
    // Map the field names
    referencedDocumentId: backend.resolvedDocumentId,
    entityType: backend.entityTypes?.[0],
    referenceType: backend.referenceTags?.[0],
    
    createdAt: backend.createdAt,
    updatedAt: backend.updatedAt,
  };
}

// API response types
export interface SelectionsApiResponse {
  selections: BackendSelection[];
  total?: number;
}

export interface SelectionApiResponse {
  selection: BackendSelection;
}

// For highlights endpoint
export interface HighlightsApiResponse {
  highlights: BackendSelection[];
  total?: number;
}

// For references endpoint  
export interface ReferencesApiResponse {
  references: BackendSelection[];
  total?: number;
}