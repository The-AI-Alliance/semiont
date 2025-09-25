/**
 * Selection API Response Schemas
 */

import { z } from '@hono/zod-openapi';

// ==========================================
// SELECTION RESPONSE SCHEMAS
// ==========================================

export const SelectionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  selectionType: z.string(),
  selectionData: z.any(),

  // Reference fields - presence determines type
  resolvedDocumentId: z.string().nullable().optional(),
  resolvedAt: z.string().datetime().optional(),
  resolvedBy: z.string().optional(),

  referenceTags: z.array(z.string()).optional(),
  entityTypes: z.array(z.string()).optional(),

  provisional: z.boolean(),
  confidence: z.number().optional(),
  metadata: z.any().optional(),

  createdBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi('Selection');

export const CreateSelectionResponseSchema = z.object({
  selection: SelectionSchema,
}).openapi('CreateSelectionResponse');

export const ResolveSelectionResponseSchema = z.object({
  selection: SelectionSchema,
}).openapi('ResolveSelectionResponse');

export const CreateDocumentFromSelectionResponseSchema = z.object({
  document: z.object({
    id: z.string(),
    name: z.string(),
    entityTypes: z.array(z.string()),
    content: z.string(),
    contentType: z.string(),
    metadata: z.any(),
    archived: z.boolean(),
    createdAt: z.string().datetime(),
  }),
  selection: SelectionSchema,
}).openapi('CreateDocumentFromSelectionResponse');

export const GenerateDocumentFromSelectionResponseSchema = z.object({
  generated: z.object({
    title: z.string(),
    content: z.string(),
    summary: z.string(),
    entityTypes: z.array(z.string()),
    suggestedReferences: z.array(z.object({
      text: z.string(),
      reason: z.string(),
    })).optional(),
  }),
  context: z.object({
    selectionText: z.string(),
    sourceDocumentName: z.string(),
    relatedDocuments: z.array(z.string()),
  }),
}).openapi('GenerateDocumentFromSelectionResponse');

export const ContextualSummaryResponseSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  relatedConcepts: z.array(z.object({
    concept: z.string(),
    relevance: z.number(),
  })),
  suggestedReferences: z.array(z.object({
    text: z.string(),
    targetHint: z.string(),
    confidence: z.number(),
  })),
}).openapi('ContextualSummaryResponse');

export const SelectionContextResponseSchema = z.object({
  selection: SelectionSchema,
  sourceContext: z.object({
    documentId: z.string(),
    documentName: z.string(),
    contentBefore: z.string(),
    contentAfter: z.string(),
  }),
  targetContext: z.object({
    documentId: z.string().nullable(),
    documentName: z.string().nullable(),
    isStub: z.boolean(),
    entityTypes: z.array(z.string()).optional(),
  }).optional(),
}).openapi('SelectionContextResponse');

export const ReferenceLLMContextResponseSchema = z.object({
  reference: z.object({
    id: z.string(),
    text: z.string(),
    type: z.string(),
    isStub: z.boolean(),
    entityTypes: z.array(z.string()).optional(),
    referenceType: z.string().optional(),
  }),
  sourceContext: z.object({
    documentId: z.string(),
    documentName: z.string(),
    contentBefore: z.string(),
    contentAfter: z.string(),
    documentSummary: z.string(),
    offset: z.number(),
  }),
  targetContext: z.object({
    documentId: z.string().nullable(),
    documentName: z.string().nullable(),
    summary: z.string().nullable(),
    isStub: z.boolean(),
  }),
  generationContext: z.object({
    suggestedContent: z.object({
      title: z.string(),
      summary: z.string(),
      keyPoints: z.array(z.string()),
      relatedConcepts: z.array(z.string()),
    }),
    contentGuidelines: z.array(z.string()),
    recommendedStructure: z.array(z.string()),
    smartSuggestions: z.array(z.string()).nullable(),
  }),
  knowledgeGraph: z.object({
    relatedDocuments: z.array(z.object({
      id: z.string(),
      name: z.string(),
      relevanceScore: z.number(),
      connectionType: z.string(),
    })),
    suggestedLinks: z.array(z.object({
      documentId: z.string(),
      documentName: z.string(),
      reason: z.string(),
      confidence: z.number(),
    })),
  }),
}).openapi('ReferenceLLMContextResponse');