/**
 * Document types - Input/filter types for document operations
 *
 */

import { z } from 'zod';
import { CreationMethod } from './creation-methods';
import { CREATION_METHODS } from './creation-methods';

/**
 * Input for creating a new document
 */
export interface CreateDocumentInput {
  name: string;
  entityTypes: string[];
  content: string;
  format: string;  // MIME type (e.g., 'text/plain', 'text/markdown')
  contentChecksum: string;  // SHA-256 hash calculated by backend
  creator: string;  // Set by backend from auth context (REQUIRED)

  // Provenance tracking (only context fields, not derived fields)
  creationMethod: CreationMethod;  // How document was created
  sourceAnnotationId?: string;  // For reference-created documents
  sourceDocumentId?: string;  // For reference-created documents
  // Note: created is set by backend
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

/**
 * Document Schema
 *
 * Core document model used across the application.
 * - contentChecksum: Required, used by backend for content-addressing and graph storage
 * - content: REMOVED - All content access must go through filesystem service via storage.getDocument(id)
 * - format: MIME type of the document content (e.g., 'text/plain', 'text/markdown') - aligned with W3C Web Annotation Data Model
 * - locale: Optional language/locale code (e.g., 'en', 'es', 'fr') for i18n support
 */
export const DocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  format: z.string(), // MIME type (e.g., 'text/plain', 'text/markdown', 'application/pdf')
  archived: z.boolean(),
  entityTypes: z.array(z.string()),
  locale: z.string().optional(), // Language/locale code (e.g., 'en', 'es', 'fr')
  creationMethod: z.enum([
    CREATION_METHODS.API,
    CREATION_METHODS.UPLOAD,
    CREATION_METHODS.UI,
    CREATION_METHODS.REFERENCE,
    CREATION_METHODS.CLONE,
    CREATION_METHODS.GENERATED,
  ] as const),
  sourceAnnotationId: z.string().optional(),
  sourceDocumentId: z.string().optional(),
  creator: z.string(),
  created: z.string(),
  contentChecksum: z.string(),
});

export type Document = z.infer<typeof DocumentSchema>;
