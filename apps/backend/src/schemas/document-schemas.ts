import { z } from '@hono/zod-openapi';

// ==========================================
// DOCUMENT SCHEMAS
// ==========================================

// Reference type schemas
export const TextSpanReferenceSchema = z.object({
  type: z.literal('text_span'),
  offset: z.number().int().min(0).openapi({ example: 100, description: 'Character offset in document' }),
  length: z.number().int().min(0).openapi({ example: 20, description: 'Length in characters' }),
  text: z.string().optional().openapi({ example: 'quantum computing', description: 'The actual text (for convenience)' }),
}).openapi('TextSpanReference');

export const ASTNodeReferenceSchema = z.object({
  type: z.literal('ast_node'),
  language: z.string().openapi({ example: 'typescript', description: 'Programming language' }),
  nodePath: z.array(z.string()).openapi({ example: ['Program', 'FunctionDeclaration', 'Identifier'], description: 'Path through AST to node' }),
  offset: z.number().int().min(0).optional().openapi({ description: 'Offset within node text' }),
  length: z.number().int().min(0).optional().openapi({ description: 'Length within node text' }),
}).openapi('ASTNodeReference');

export const ImageRegionReferenceSchema = z.object({
  type: z.literal('image_region'),
  shape: z.enum(['rectangle', 'circle', 'polygon']).openapi({ example: 'rectangle' }),
  coordinates: z.array(z.number()).openapi({ example: [10, 20, 100, 150], description: 'Shape-specific coordinates' }),
}).openapi('ImageRegionReference');

export const AudioSegmentReferenceSchema = z.object({
  type: z.literal('audio_segment'),
  startTime: z.number().min(0).openapi({ example: 1000, description: 'Start time in milliseconds' }),
  duration: z.number().min(0).openapi({ example: 5000, description: 'Duration in milliseconds' }),
}).openapi('AudioSegmentReference');

export const ReferenceTypeSchema = z.discriminatedUnion('type', [
  TextSpanReferenceSchema,
  ASTNodeReferenceSchema,
  ImageRegionReferenceSchema,
  AudioSegmentReferenceSchema,
]).openapi('ReferenceType');

// Document schema
export const DocumentSchema = z.object({
  id: z.string().openapi({ example: 'doc_abc123' }),
  name: z.string().openapi({ example: 'Introduction to Quantum Computing' }),
  entityTypes: z.array(z.string()).openapi({ example: ['Technology', 'Topic'] }),
  content: z.string().openapi({ example: 'Quantum computing is a revolutionary...' }),
  contentType: z.string().openapi({ example: 'text/plain', description: 'MIME type' }),
  metadata: z.record(z.any()).optional().openapi({ example: { author: 'John Doe', tags: ['quantum', 'computing'] } }),
  storageUrl: z.string().optional().openapi({ example: '/efs/documents/doc_abc123.txt' }),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
  createdAt: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  updatedAt: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
}).openapi('Document');

// Reference schema
export const ReferenceSchema = z.object({
  id: z.string().openapi({ example: 'ref_xyz789' }),
  documentId: z.string().openapi({ example: 'doc_abc123' }),
  referenceType: z.string().openapi({ example: 'text_span' }),
  referenceData: z.any().openapi({ description: 'Type-specific reference data' }),
  resolvedDocumentId: z.string().optional().openapi({ example: 'doc_def456' }),
  provisional: z.boolean().default(false).openapi({ example: false }),
  confidence: z.number().min(0).max(1).optional().openapi({ example: 0.85 }),
  metadata: z.record(z.any()).optional(),
  resolvedBy: z.string().optional(),
  resolvedAt: z.string().optional(),
  createdAt: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  updatedAt: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
}).openapi('Reference');

// Request schemas
export const CreateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(255).openapi({ example: 'My Document' }),
  entityTypes: z.array(z.string()).optional().openapi({ example: ['Person', 'Author'] }),
  content: z.string().openapi({ example: 'Document content here...' }),
  contentType: z.string().default('text/plain').openapi({ example: 'text/plain' }),
  metadata: z.record(z.any()).optional(),
  references: z.array(z.object({
    referenceType: ReferenceTypeSchema,
    resolvedDocumentId: z.string().optional(),
    provisional: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional(),
    metadata: z.record(z.any()).optional(),
  })).optional(),
}).openapi('CreateDocumentRequest');

export const UpdateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  entityTypes: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
}).openapi('UpdateDocumentRequest');

export const CreateReferenceRequestSchema = z.object({
  documentId: z.string().openapi({ example: 'doc_abc123' }),
  referenceType: ReferenceTypeSchema,
  resolvedDocumentId: z.string().optional(),
  metadata: z.record(z.any()).optional(),
}).openapi('CreateReferenceRequest');

export const DetectReferencesRequestSchema = z.object({
  includeProvisional: z.boolean().optional().default(true),
  confidenceThreshold: z.number().min(0).max(1).optional().default(0.5),
}).openapi('DetectReferencesRequest');

export const ResolveReferenceRequestSchema = z.object({
  metadata: z.object({
    resolvedBy: z.string().optional(),
    reason: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  }).optional(),
}).openapi('ResolveReferenceRequest');

export const CreateDocumentFromReferenceRequestSchema = z.object({
  name: z.string().min(1).max(255).openapi({ example: 'New Document' }),
  entityTypes: z.array(z.string()).optional(),
  content: z.string().optional(),
  contentType: z.string().optional().default('text/plain'),
  metadata: z.record(z.any()).optional(),
  autoResolve: z.boolean().optional().default(true),
}).openapi('CreateDocumentFromReferenceRequest');

export const GenerateDocumentFromReferenceRequestSchema = z.object({
  name: z.string().optional(),
  entityTypes: z.array(z.string()).optional(),
  contextWindow: z.object({
    before: z.number().int().min(0).optional().default(500),
    after: z.number().int().min(0).optional().default(500),
  }).optional(),
  autoResolve: z.boolean().optional().default(true),
}).openapi('GenerateDocumentFromReferenceRequest');

// Response schemas
export const CreateDocumentResponseSchema = z.object({
  document: DocumentSchema,
  references: z.array(ReferenceSchema),
}).openapi('CreateDocumentResponse');

export const GetDocumentResponseSchema = z.object({
  document: DocumentSchema,
  references: z.array(ReferenceSchema),
  referencedBy: z.array(ReferenceSchema),
}).openapi('GetDocumentResponse');

export const ListDocumentsResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  total: z.number(),
}).openapi('ListDocumentsResponse');

export const DetectReferencesResponseSchema = z.object({
  references: z.array(z.object({
    reference: ReferenceSchema,
    suggestedResolutions: z.array(z.object({
      documentId: z.string(),
      documentName: z.string(),
      entityTypes: z.array(z.string()),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    })).optional(),
  })),
}).openapi('DetectReferencesResponse');

export const CreateDocumentFromReferenceResponseSchema = z.object({
  document: DocumentSchema,
  reference: ReferenceSchema,
  sourceContext: z.object({
    document: DocumentSchema,
    contextWindow: z.string(),
  }).optional(),
}).openapi('CreateDocumentFromReferenceResponse');

export const GenerateDocumentFromReferenceResponseSchema = z.object({
  document: DocumentSchema,
  reference: ReferenceSchema,
  generationMetadata: z.object({
    contextUsed: z.string(),
    confidence: z.number().min(0).max(1),
    suggestedLinks: z.array(z.object({
      documentId: z.string(),
      documentName: z.string(),
      relevance: z.number().min(0).max(1),
    })),
  }),
}).openapi('GenerateDocumentFromReferenceResponse');

export const ContextualSummaryResponseSchema = z.object({
  summary: z.object({
    title: z.string(),
    briefDescription: z.string(),
    fields: z.record(z.any()),
    relevantSections: z.array(z.object({
      heading: z.string(),
      content: z.string(),
      relevance: z.number().min(0).max(1),
    })),
    relatedDocuments: z.array(z.object({
      documentId: z.string(),
      name: z.string(),
      relationship: z.string(),
    })),
  }),
  metadata: z.object({
    documentId: z.string(),
    referenceId: z.string(),
    referenceContext: z.object({
      sourceDocument: DocumentSchema,
      contextWindow: z.string(),
    }),
    generatedAt: z.string(),
  }),
}).openapi('ContextualSummaryResponse');

export const ReferenceContextResponseSchema = z.object({
  reference: ReferenceSchema,
  sourceDocument: DocumentSchema,
  context: z.object({
    before: z.string(),
    referenceContent: z.string(),
    after: z.string(),
    section: z.string().optional(),
    paragraph: z.number().optional(),
    nearbyReferences: z.array(z.object({
      reference: ReferenceSchema,
      distance: z.number(),
    })).optional(),
  }),
}).openapi('ReferenceContextResponse');

export const GraphConnectionsResponseSchema = z.object({
  document: DocumentSchema,
  connections: z.array(z.object({
    targetDocument: DocumentSchema,
    references: z.array(ReferenceSchema),
    relationshipType: z.string().optional(),
    bidirectional: z.boolean(),
  })),
}).openapi('GraphConnectionsResponse');

export const StatsResponseSchema = z.object({
  documentCount: z.number(),
  referenceCount: z.number(),
  resolvedReferenceCount: z.number(),
  entityTypes: z.record(z.number()),
  contentTypes: z.record(z.number()),
}).openapi('StatsResponse');