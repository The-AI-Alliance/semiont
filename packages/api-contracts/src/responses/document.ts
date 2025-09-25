/**
 * Document API Response Schemas
 */

import { z } from '@hono/zod-openapi';

// ==========================================
// DOCUMENT RESPONSE SCHEMAS
// ==========================================

export const DocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  entityTypes: z.array(z.string()),
  content: z.string(),
  contentType: z.string(),
  metadata: z.any(),
  archived: z.boolean(),
  createdAt: z.string().datetime(),
  createdBy: z.string().optional(),
  creationMethod: z.string(),
  contentChecksum: z.string(),
  sourceSelectionId: z.string().optional(),
  sourceDocumentId: z.string().optional(),
}).openapi('Document');

export const CreateDocumentResponseSchema = z.object({
  document: DocumentSchema,
}).openapi('CreateDocumentResponse');

export const GetDocumentResponseSchema = z.object({
  document: DocumentSchema,
}).openapi('GetDocumentResponse');

export const UpdateDocumentResponseSchema = z.object({
  document: DocumentSchema,
}).openapi('UpdateDocumentResponse');

export const ListDocumentsResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
}).openapi('ListDocumentsResponse');

export const DetectSelectionsResponseSchema = z.object({
  selections: z.array(z.object({
    id: z.string(),
    documentId: z.string(),
    selectionType: z.string(),
    selectionData: z.any(),
    provisional: z.boolean(),
    confidence: z.number().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })),
  detected: z.number().int().min(0),
}).openapi('DetectSelectionsResponse');

export const DiscoverContextResponseSchema = z.object({
  analysis: z.object({
    detectedEntities: z.array(z.object({
      text: z.string(),
      type: z.string(),
      confidence: z.number(),
    })),
    detectedTopics: z.array(z.string()),
  }),
  relevantDocuments: z.array(z.object({
    id: z.string(),
    name: z.string(),
    entityTypes: z.array(z.string()),
    relevanceScore: z.number(),
    matchType: z.string(),
    snippet: z.string(),
    matchedPhrases: z.array(z.string()),
  })),
  relevantSelections: z.array(z.object({
    id: z.string(),
    documentId: z.string(),
    text: z.string(),
    relevanceScore: z.number(),
  })),
}).openapi('DiscoverContextResponse');

export const DocumentLLMContextResponseSchema = z.object({
  document: z.object({
    id: z.string(),
    name: z.string(),
    entityTypes: z.array(z.string()),
    metadata: z.any(),
    archived: z.boolean(),
    createdAt: z.string(),
  }),
  contentSummary: z.string(),
  statistics: z.object({
    wordCount: z.number(),
    highlightCount: z.number(),
    referenceCount: z.number(),
    stubReferenceCount: z.number(),
    incomingReferenceCount: z.number(),
  }),
  highlights: z.array(z.object({
    id: z.string(),
    text: z.string(),
    type: z.string(),
    position: z.object({
      offset: z.number(),
      length: z.number(),
    }),
  })),
  references: z.array(z.object({
    id: z.string(),
    text: z.string(),
    targetDocumentId: z.string().nullable(),
    targetDocumentName: z.string().nullable(),
    isStub: z.boolean(),
    entityTypes: z.array(z.string()).optional(),
    referenceTags: z.array(z.string()).optional(),
  })),
  incomingReferences: z.array(z.object({
    fromDocumentId: z.string(),
    fromDocumentName: z.string(),
    selectionId: z.string(),
    text: z.string(),
  })),
  relatedDocuments: z.array(z.object({
    id: z.string(),
    name: z.string(),
    entityTypes: z.array(z.string()),
    relationshipType: z.string(),
  })),
  graphContext: z.object({
    directConnections: z.number(),
    secondDegreeConnections: z.number(),
    centralityScore: z.number().optional(),
    clusters: z.array(z.string()).optional(),
  }),
}).openapi('DocumentLLMContextResponse');