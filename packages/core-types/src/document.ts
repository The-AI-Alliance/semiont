/**
 * Document types - Core domain model for documents in the system
 */

import { CreationMethod } from './creation-methods';

/**
 * Core document entity representing any document in the system
 */
export interface Document {
  id: string;
  name: string;
  entityTypes: string[];
  contentType: string;
  metadata: Record<string, any>;
  archived: boolean;  // Whether the document is archived (read-only)

  // Audit fields (backend-controlled)
  createdBy: string;  // Set from auth context by backend
  createdAt: Date;    // Set by backend on creation

  // Provenance tracking (backend-controlled with optional client context)
  creationMethod: CreationMethod;  // How document was created
  contentChecksum: string;  // SHA-256 hash calculated by backend for integrity
  sourceSelectionId?: string;  // If created from reference, the selection that triggered it
  sourceDocumentId?: string;  // If created from reference/clone, the source document
}

/**
 * Input for creating a new document
 */
export interface CreateDocumentInput {
  name: string;
  entityTypes: string[];
  content: string;
  contentType: string;
  contentChecksum: string;  // SHA-256 hash calculated by backend
  metadata: Record<string, any>;
  createdBy: string;  // Set by backend from auth context (REQUIRED)

  // Provenance tracking (only context fields, not derived fields)
  creationMethod: CreationMethod;  // How document was created
  sourceSelectionId?: string;  // For reference-created documents
  sourceDocumentId?: string;  // For reference-created documents
  // Note: createdAt is set by backend
}

/**
 * Input for updating an existing document
 */
export interface UpdateDocumentInput {
  name?: string;
  entityTypes?: string[];
  metadata?: Record<string, any>;
  archived?: boolean;
}

/**
 * Filter criteria for querying documents
 */
export interface DocumentFilter {
  entityTypes?: string[];
  search?: string;
  limit?: number;
  offset?: number;
}