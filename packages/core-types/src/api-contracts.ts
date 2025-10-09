/**
 * API Contract Schemas
 *
 * Pure Zod schemas defining REST API contracts.
 * Backend uses these for validation, frontend for type inference.
 *
 * NOTE: This file uses ONLY plain Zod - no @hono/zod-openapi
 * to avoid memory issues during typecheck.
 */

import { z } from 'zod';
import { CREATION_METHODS } from './creation-methods';
import { AnnotationSchema } from './annotation-schema';

/**
 * Create Annotation API Request
 *
 * Frontend-to-backend API format for creating an annotation.
 * createdBy is derived from authenticated user on backend.
 */
export const CreateAnnotationRequestSchema = z.object({
  target: z.object({
    source: z.string(),
    selector: z.object({
      type: z.literal("TextPositionSelector"),
      exact: z.string(),
      offset: z.number(),
      length: z.number(),
    }),
  }),
  body: z.object({
    type: z.enum(['highlight', 'reference']),
    entityTypes: z.array(z.string()).optional(),
    referenceType: z.string().optional(),
    referencedDocumentId: z.string().nullable().optional(),
  }),
});

export type CreateAnnotationRequest = z.infer<typeof CreateAnnotationRequestSchema>;

/**
 * Create Annotation Internal Input
 *
 * Backend internal format used by graph implementations when consuming events.
 * Includes createdBy from the event's userId.
 */
export const CreateAnnotationInternalSchema = CreateAnnotationRequestSchema.extend({
  createdBy: z.string(),
});

export type CreateAnnotationInternal = z.infer<typeof CreateAnnotationInternalSchema>;

/**
 * Create Annotation Response
 */
export const CreateAnnotationResponseSchema = z.object({
  annotation: AnnotationSchema,
});

export type CreateAnnotationResponse = z.infer<typeof CreateAnnotationResponseSchema>;


/**
 * Text selection (position in document)
 */
export interface TextSelection {
  exact: string;  // W3C Web Annotation standard
  start: number;
  end: number;
}

/**
 * Get Highlights Response
 */
export const GetHighlightsResponseSchema = z.object({
  highlights: z.array(AnnotationSchema),
});

export type GetHighlightsResponse = z.infer<typeof GetHighlightsResponseSchema>;

/**
 * Get References Response
 */
export const GetReferencesResponseSchema = z.object({
  references: z.array(AnnotationSchema),
});

export type GetReferencesResponse = z.infer<typeof GetReferencesResponseSchema>;

/**
 * Document Schema
 *
 * Core document model used across the application.
 * - contentChecksum: Required, used by backend for content-addressing and graph storage
 * - content: REMOVED - All content access must go through filesystem service via storage.getDocument(id)
 */
export const DocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string(),
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
  createdBy: z.string(),
  createdAt: z.string(),
  contentChecksum: z.string(),
});

export type Document = z.infer<typeof DocumentSchema>;

/**
 * Create Document Request
 */
export const CreateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(500),
  content: z.string(),
  contentType: z.string().optional().default('text/plain'),
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
 * Delete Annotation Request
 */
export const DeleteAnnotationRequestSchema = z.object({
  documentId: z.string().describe('Document ID containing the annotation (required for O(1) Layer 3 lookup)'),
});

export type DeleteAnnotationRequest = z.infer<typeof DeleteAnnotationRequestSchema>;

/**
 * Delete Annotation Response
 */
export const DeleteAnnotationResponseSchema = z.object({
  success: z.boolean(),
});

export type DeleteAnnotationResponse = z.infer<typeof DeleteAnnotationResponseSchema>;

/**
 * Admin User Schema
 */
export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  domain: z.string(),
  provider: z.string(),
  isAdmin: z.boolean(),
  isActive: z.boolean(),
  lastLogin: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AdminUser = z.infer<typeof AdminUserSchema>;

/**
 * Admin Users List Response
 */
export const AdminUsersResponseSchema = z.object({
  success: z.boolean(),
  users: z.array(AdminUserSchema),
});

export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

/**
 * Admin User Stats Response
 */
export const AdminUserStatsResponseSchema = z.object({
  success: z.boolean(),
  stats: z.object({
    totalUsers: z.number(),
    activeUsers: z.number(),
    adminUsers: z.number(),
    regularUsers: z.number(),
    domainBreakdown: z.array(z.object({
      domain: z.string(),
      count: z.number(),
    })),
    recentSignups: z.array(z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      createdAt: z.string(),
    })),
  }),
});

export type AdminUserStatsResponse = z.infer<typeof AdminUserStatsResponseSchema>;

/**
 * Update User Request
 */
export const UpdateUserRequestSchema = z.object({
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
  name: z.string().optional(),
});

export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

/**
 * OAuth Provider Schema
 */
export const OAuthProviderSchema = z.object({
  name: z.string(),
  clientId: z.string(),
  isConfigured: z.boolean(),
});

export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

/**
 * OAuth Config Response
 */
export const OAuthConfigResponseSchema = z.object({
  providers: z.array(OAuthProviderSchema),
  allowedDomains: z.array(z.string()),
});

export type OAuthConfigResponse = z.infer<typeof OAuthConfigResponseSchema>;

/**
 * Referenced By - Documents that reference a specific document
 */
export const ReferencedBySchema = z.object({
  id: z.string().describe('Reference annotation ID'),
  documentName: z.string().describe('Name of document containing the reference'),
  target: z.object({
    source: z.string().describe('ID of document containing the reference'),
    selector: z.object({
      exact: z.string().describe('The selected text that references this document'),
    }),
  }),
});

export type ReferencedBy = z.infer<typeof ReferencedBySchema>;

/**
 * Accept Terms Response
 */
export const AcceptTermsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type AcceptTermsResponse = z.infer<typeof AcceptTermsResponseSchema>;

/**
 * Add Entity Type Response
 */
export const AddEntityTypeResponseSchema = z.object({
  success: z.boolean(),
  entityTypes: z.array(z.string()),
});

export type AddEntityTypeResponse = z.infer<typeof AddEntityTypeResponseSchema>;

/**
 * Add Reference Type Response
 */
export const AddReferenceTypeResponseSchema = z.object({
  success: z.boolean(),
  referenceTypes: z.array(z.string()),
});

export type AddReferenceTypeResponse = z.infer<typeof AddReferenceTypeResponseSchema>;

/**
 * Generate Document From Selection Request
 */
export const GenerateDocumentFromSelectionRequestSchema = z.object({
  name: z.string().min(1).max(255).optional().describe('Custom title for generated document'),
  entityTypes: z.array(z.string()).optional().describe('Entity types to apply to generated document'),
  prompt: z.string().optional().describe('Custom prompt for content generation'),
});

export type GenerateDocumentFromSelectionRequest = z.infer<typeof GenerateDocumentFromSelectionRequestSchema>;

/**
 * Generate Document From Selection Response
 */
export const GenerateDocumentFromSelectionResponseSchema = z.object({
  document: DocumentSchema,
  annotation: AnnotationSchema,
  generated: z.boolean(),
});

export type GenerateDocumentFromSelectionResponse = z.infer<typeof GenerateDocumentFromSelectionResponseSchema>;

/**
 * Resolve Selection Request
 */
export const ResolveSelectionRequestSchema = z.object({
  documentId: z.string().describe('Target document ID to resolve reference to'),
});

export type ResolveSelectionRequest = z.infer<typeof ResolveSelectionRequestSchema>;

/**
 * Resolve Selection Response
 */
export const ResolveSelectionResponseSchema = z.object({
  annotation: AnnotationSchema,
  targetDocument: DocumentSchema.nullable(),
});

export type ResolveSelectionResponse = z.infer<typeof ResolveSelectionResponseSchema>;

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
