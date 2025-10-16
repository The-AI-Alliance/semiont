/**
 * Document Schemas and API Contracts
 *
 * Core document types and API contracts for document-related endpoints.
 */

import { z } from 'zod';
import { AnnotationSchema, DocumentSchema } from './base-schemas';
import type { CreationMethod } from './creation-methods';

// Re-export DocumentSchema and Document from base-schemas for backward compatibility
export { DocumentSchema } from './base-schemas';
export type { Document } from './base-schemas';

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

// DocumentSchema and Document type are imported from base-schemas above

/**
 * Create Document Request
 */
export const CreateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(500),
  content: z.string(),
  format: z.string(), // MIME type (required)
  entityTypes: z.array(z.string()), // Required - caller must explicitly pass [] for no types
  locale: z.string().optional(), // Language/locale code (e.g., 'en', 'es', 'fr')
  creationMethod: z.string().optional(),
  sourceAnnotationId: z.string().optional(),
  sourceDocumentId: z.string().optional(),
});

export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

/**
 * Update Document Request
 * Only allows append-only operations - document name and content are immutable
 */
export const UpdateDocumentRequestSchema = z.object({
  entityTypes: z.array(z.string()).optional(),
  archived: z.boolean().optional(), // Can archive (one-way operation)
});

export type UpdateDocumentRequest = z.infer<typeof UpdateDocumentRequestSchema>;

/**
 * Create Document Response
 */
export const CreateDocumentResponseSchema = z.object({
  document: DocumentSchema,
  annotations: z.array(AnnotationSchema),
});

export type CreateDocumentResponse = z.infer<typeof CreateDocumentResponseSchema>;

/**
 * Get Document Response
 * Note: Content must be fetched separately via GET /documents/:id/content
 */
export const GetDocumentResponseSchema = z.object({
  document: DocumentSchema, // Metadata only - no content field
  annotations: z.array(AnnotationSchema),
  highlights: z.array(AnnotationSchema),
  references: z.array(AnnotationSchema),
  entityReferences: z.array(AnnotationSchema),
});

export type GetDocumentResponse = z.infer<typeof GetDocumentResponseSchema>;

/**
 * List Documents Response
 */
export const ListDocumentsResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
});

export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponseSchema>;

/**
 * Generate Document From Annotation Request
 */
export const GenerateDocumentFromAnnotationRequestSchema = z.object({
  name: z.string().min(1).max(255).optional().describe('Custom title for generated document'),
  entityTypes: z.array(z.string()).optional().describe('Entity types to apply to generated document'),
  prompt: z.string().optional().describe('Custom prompt for content generation'),
  locale: z.string().optional().describe('Language locale for generated content (e.g., "es", "fr", "ja")'),
});

export type GenerateDocumentFromAnnotationRequest = z.infer<typeof GenerateDocumentFromAnnotationRequestSchema>;

/**
 * Generate Document From Annotation Response
 */
export const GenerateDocumentFromAnnotationResponseSchema = z.object({
  document: DocumentSchema,
  annotation: AnnotationSchema,
  generated: z.boolean(),
});

export type GenerateDocumentFromAnnotationResponse = z.infer<typeof GenerateDocumentFromAnnotationResponseSchema>;

/**
 * Get Document By Token Response
 */
export const GetDocumentByTokenResponseSchema = z.object({
  sourceDocument: DocumentSchema,
  expiresAt: z.string().describe('ISO 8601 timestamp when token expires'),
});

export type GetDocumentByTokenResponse = z.infer<typeof GetDocumentByTokenResponseSchema>;

/**
 * Create Document From Token Request
 */
export const CreateDocumentFromTokenRequestSchema = z.object({
  token: z.string().describe('Clone token'),
  name: z.string().describe('Name for the new document'),
  content: z.string().describe('Content for the new document'),
  archiveOriginal: z.boolean().optional().describe('Whether to archive the original document'),
});

export type CreateDocumentFromTokenRequest = z.infer<typeof CreateDocumentFromTokenRequestSchema>;

/**
 * Create Document From Token Response
 */
export const CreateDocumentFromTokenResponseSchema = z.object({
  document: DocumentSchema,
  annotations: z.array(AnnotationSchema),
});

export type CreateDocumentFromTokenResponse = z.infer<typeof CreateDocumentFromTokenResponseSchema>;

/**
 * Clone Document With Token Response
 */
export const CloneDocumentWithTokenResponseSchema = z.object({
  token: z.string().describe('Generated clone token'),
  expiresAt: z.string().describe('ISO 8601 timestamp when token expires'),
  document: DocumentSchema,
});

export type CloneDocumentWithTokenResponse = z.infer<typeof CloneDocumentWithTokenResponseSchema>;

/**
 * Document LLM Context Response
 */
export const DocumentLLMContextResponseSchema = z.object({
  mainDocument: DocumentSchema.extend({
    content: z.string().optional(),
  }),
  relatedDocuments: z.array(DocumentSchema),
  annotations: z.array(AnnotationSchema),
  graph: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      metadata: z.record(z.string(), z.any()),
    })),
    edges: z.array(z.object({
      source: z.string(),
      target: z.string(),
      type: z.string(),
      metadata: z.record(z.string(), z.any()),
    })),
  }),
  summary: z.string().optional(),
  suggestedReferences: z.array(z.string()).optional(),
});

export type DocumentLLMContextResponse = z.infer<typeof DocumentLLMContextResponseSchema>;

/**
 * Create Document from Selection Response
 */
export const CreateDocumentFromSelectionResponseSchema = z.object({
  document: DocumentSchema,
  annotation: AnnotationSchema,
});

export type CreateDocumentFromSelectionResponse = z.infer<typeof CreateDocumentFromSelectionResponseSchema>;
