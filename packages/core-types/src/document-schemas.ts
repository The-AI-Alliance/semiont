/**
 * Document types - Input/filter types for document operations
 *
 */

import { z } from 'zod';
import { CreationMethod } from './creation-methods';
import { CREATION_METHODS } from './creation-methods';
import { AnnotationSchema } from './annotation-schemas';

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
 */
export const DocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  format: z.string(), // MIME type (e.g., 'text/plain', 'text/markdown', 'application/pdf')
  archived: z.boolean(),
  entityTypes: z.array(z.string()),
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

/**
 * Create Document Request
 */
export const CreateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(500),
  content: z.string(),
  format: z.string().optional().default('text/plain'), // MIME type
  entityTypes: z.array(z.string()).optional().default([]),
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
