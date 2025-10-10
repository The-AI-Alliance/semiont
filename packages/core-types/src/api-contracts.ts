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
import { AnnotationSchema } from './annotation-schema';
import { DocumentSchema } from './document';

/**
 * Selector Types (imported from annotation-schema for consistency)
 */
const TextPositionSelectorSchema = z.object({
  type: z.literal("TextPositionSelector"),
  exact: z.string(),
  offset: z.number(),
  length: z.number(),
});

const TextQuoteSelectorSchema = z.object({
  type: z.literal("TextQuoteSelector"),
  exact: z.string(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});

const SelectorSchema = z.union([
  TextPositionSelectorSchema,
  TextQuoteSelectorSchema,
]);

/**
 * Create Annotation API Request
 *
 * Frontend-to-backend API format for creating an annotation.
 * creator is derived from authenticated user on backend.
 *
 * Phase 2: Multi-Selector Support
 * - selector can be single selector or array of selectors
 * - Multiple selectors identify the same text using different methods
 */
export const CreateAnnotationRequestSchema = z.object({
  target: z.object({
    source: z.string(),
    selector: z.union([
      SelectorSchema,
      z.array(SelectorSchema),
    ]),
  }),
  body: z.object({
    type: z.enum(['TextualBody', 'SpecificResource']),
    value: z.string().optional(),
    source: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).optional(),
  }),
});

export type CreateAnnotationRequest = z.infer<typeof CreateAnnotationRequestSchema>;

/**
 * Create Annotation Internal Input
 *
 * Backend internal format used by graph implementations when consuming events.
 * Includes creator from the event's userId.
 */
export const CreateAnnotationInternalSchema = CreateAnnotationRequestSchema.extend({
  creator: z.string(),
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
 * Get All Annotations Response (both highlights and references)
 */
export const GetAnnotationsResponseSchema = z.object({
  annotations: z.array(AnnotationSchema),
});

export type GetAnnotationsResponse = z.infer<typeof GetAnnotationsResponseSchema>;

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
  created: z.string(),
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
      created: z.string(),
    })),
  }),
});

export type AdminUserStatsResponse = z.infer<typeof AdminUserStatsResponseSchema>;

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
 * Get Referenced By Response
 */
export const GetReferencedByResponseSchema = z.object({
  referencedBy: z.array(ReferencedBySchema),
});

export type GetReferencedByResponse = z.infer<typeof GetReferencedByResponseSchema>;

/**
 * Accept Terms Response
 */
export const AcceptTermsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type AcceptTermsResponse = z.infer<typeof AcceptTermsResponseSchema>;

/**
 * Token Refresh Response
 */
export const TokenRefreshResponseSchema = z.object({
  access_token: z.string(),
});

export type TokenRefreshResponse = z.infer<typeof TokenRefreshResponseSchema>;

/**
 * MCP Generate Response
 */
export const MCPGenerateResponseSchema = z.object({
  refresh_token: z.string(),
});

export type MCPGenerateResponse = z.infer<typeof MCPGenerateResponseSchema>;

/**
 * Logout Response
 */
export const LogoutResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

/**
 * Update User Response
 */
export const UpdateUserResponseSchema = z.object({
  success: z.boolean(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    domain: z.string(),
    provider: z.string(),
    isAdmin: z.boolean(),
    isActive: z.boolean(),
    lastLogin: z.string().nullable(),
    created: z.string(),
    updatedAt: z.string(),
  }),
});

export type UpdateUserResponse = z.infer<typeof UpdateUserResponseSchema>;

/**
 * Delete User Response
 */
export const DeleteUserResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type DeleteUserResponse = z.infer<typeof DeleteUserResponseSchema>;

/**
 * OAuth Config Response
 */
export const OAuthConfigResponseSchemaActual = z.object({
  providers: z.array(z.object({
    name: z.string(),
    isConfigured: z.boolean(),
    clientId: z.string(),
  })),
  allowedDomains: z.array(z.string()),
});

export type OAuthConfigResponseActual = z.infer<typeof OAuthConfigResponseSchemaActual>;

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
 * Resolve Annotation Request
 */
export const ResolveAnnotationRequestSchema = z.object({
  documentId: z.string().describe('Target document ID to resolve reference to'),
});

export type ResolveAnnotationRequest = z.infer<typeof ResolveAnnotationRequestSchema>;

/**
 * Resolve Annotation Response
 */
export const ResolveAnnotationResponseSchema = z.object({
  annotation: AnnotationSchema,
  targetDocument: DocumentSchema.nullable(),
});

export type ResolveAnnotationResponse = z.infer<typeof ResolveAnnotationResponseSchema>;

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
 * Detect Annotations Response
 */
export const DetectAnnotationsResponseSchema = z.object({
  annotations: z.array(z.object({
    id: z.string(),
    documentId: z.string(),
    selector: z.union([SelectorSchema, z.array(SelectorSchema)]),
    source: z.string().nullable(),
    entityTypes: z.array(z.string()),
    created: z.string(),
  })),
  detected: z.number(),
});

export type DetectAnnotationsResponse = z.infer<typeof DetectAnnotationsResponseSchema>;

/**
 * Discover Context Response
 */
export const DiscoverContextResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  connections: z.array(z.object({
    fromId: z.string(),
    toId: z.string(),
    type: z.string(),
    metadata: z.record(z.string(), z.any()),
  })),
});

export type DiscoverContextResponse = z.infer<typeof DiscoverContextResponseSchema>;

/**
 * Reference LLM Context Response
 */
export const ReferenceLLMContextResponseSchema = z.object({
  reference: AnnotationSchema,
  sourceDocument: DocumentSchema,
  targetDocument: DocumentSchema.nullable(),
  sourceContext: z.object({
    before: z.string(),
    selected: z.string(),
    after: z.string(),
  }).optional(),
  targetContext: z.object({
    content: z.string(),
    summary: z.string().optional(),
  }).optional(),
  suggestedResolution: z.object({
    documentId: z.string(),
    documentName: z.string(),
    confidence: z.number(),
    reasoning: z.string(),
  }).optional(),
});

export type ReferenceLLMContextResponse = z.infer<typeof ReferenceLLMContextResponseSchema>;

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
 * Get Events Response
 */
export const GetEventsResponseSchema = z.object({
  events: z.array(z.object({
    event: z.object({
      id: z.string(),
      type: z.string(),
      timestamp: z.string(),
      userId: z.string(),
      documentId: z.string(),
      payload: z.any(),
    }),
    metadata: z.object({
      sequenceNumber: z.number(),
      prevEventHash: z.string().optional(),
      checksum: z.string().optional(),
    }),
  })),
  total: z.number(),
  documentId: z.string(),
});

export type GetEventsResponse = z.infer<typeof GetEventsResponseSchema>;

/**
 * Get Annotation Response
 */
export const GetAnnotationResponseSchema = z.object({
  annotation: AnnotationSchema,
  document: DocumentSchema.nullable(),
  resolvedDocument: DocumentSchema.nullable(),
});

export type GetAnnotationResponse = z.infer<typeof GetAnnotationResponseSchema>;

/**
 * List Annotations Response
 */
export const ListAnnotationsResponseSchema = z.object({
  annotations: z.array(AnnotationSchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
});

export type ListAnnotationsResponse = z.infer<typeof ListAnnotationsResponseSchema>;

/**
 * Create Document from Selection Response
 */
export const CreateDocumentFromSelectionResponseSchema = z.object({
  document: DocumentSchema,
  annotation: AnnotationSchema,
});

export type CreateDocumentFromSelectionResponse = z.infer<typeof CreateDocumentFromSelectionResponseSchema>;

/**
 * Annotation Context Response
 */
export const AnnotationContextResponseSchema = z.object({
  annotation: z.object({
    id: z.string(),
    documentId: z.string(),
    selector: z.object({
      exact: z.string(),
      offset: z.number(),
      length: z.number(),
    }),
    referencedDocumentId: z.string().nullable(),
    entityTypes: z.array(z.string()),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
  document: DocumentSchema,
});

export type AnnotationContextResponse = z.infer<typeof AnnotationContextResponseSchema>;

/**
 * Contextual Summary Response
 */
export const ContextualSummaryResponseSchema = z.object({
  summary: z.string(),
  relevantFields: z.record(z.string(), z.any()),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
});

export type ContextualSummaryResponse = z.infer<typeof ContextualSummaryResponseSchema>;
