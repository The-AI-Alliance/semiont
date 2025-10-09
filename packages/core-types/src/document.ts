/**
 * Document types - Input/filter types for document operations
 *
 * NOTE: The Document type itself is in api-contracts.ts (single source of truth)
 */

import { CreationMethod } from './creation-methods';

/**
 * Input for creating a new document
 */
export interface CreateDocumentInput {
  name: string;
  entityTypes: string[];
  content: string;
  contentType: string;
  contentChecksum: string;  // SHA-256 hash calculated by backend
  createdBy: string;  // Set by backend from auth context (REQUIRED)

  // Provenance tracking (only context fields, not derived fields)
  creationMethod: CreationMethod;  // How document was created
  sourceAnnotationId?: string;  // For reference-created documents
  sourceDocumentId?: string;  // For reference-created documents
  // Note: createdAt is set by backend
}

/**
 * Input for updating an existing document
 */
export interface UpdateDocumentInput {
  name?: string;
  entityTypes?: string[];
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