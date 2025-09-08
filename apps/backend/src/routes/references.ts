import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { authMiddleware } from '../middleware/auth';
import { User } from '@prisma/client';
import { ErrorResponseSchema } from '../openapi';
import { getGraphDatabase } from '../graph/factory';
import { getStorageService } from '../storage/filesystem';
import type { Document, Reference } from '../graph/types';
import {
  ReferenceSchema,
  DocumentSchema,
  CreateReferenceRequestSchema,
  ResolveReferenceRequestSchema,
  CreateDocumentFromReferenceRequestSchema,
  CreateDocumentFromReferenceResponseSchema,
  GenerateDocumentFromReferenceRequestSchema,
  GenerateDocumentFromReferenceResponseSchema,
  ContextualSummaryResponseSchema,
  ReferenceContextResponseSchema,
} from '../schemas/document-schemas';

// Create references router
export const referencesRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth middleware to all reference routes
referencesRouter.use('/api/references/*', authMiddleware);

// ==========================================
// CREATE REFERENCE
// ==========================================

const createReferenceRoute = createRoute({
  method: 'post',
  path: '/api/references',
  summary: 'Create Reference',
  description: 'Create a manual reference',
  tags: ['References'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateReferenceRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: ReferenceSchema,
        },
      },
      description: 'Reference created successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Invalid request',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

referencesRouter.openapi(createReferenceRoute, async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  try {
    const graphDb = await getGraphDatabase();
    
    // Verify document exists
    const document = await graphDb.getDocument(body.documentId);

    if (!document) {
      return c.json({ error: 'Document not found' }, 404);
    }

    // Verify resolved document exists if provided
    if (body.resolvedDocumentId) {
      const resolvedDoc = await graphDb.getDocument(body.resolvedDocumentId);

      if (!resolvedDoc) {
        return c.json({ error: 'Resolved document not found' }, 404);
      }
    }

    const refInput: any = {
      documentId: body.documentId,
      referenceType: body.referenceType.type,
      referenceData: body.referenceType,
    };
    if (body.resolvedDocumentId) refInput.resolvedDocumentId = body.resolvedDocumentId;
    if (body.metadata) refInput.metadata = body.metadata;
    if (body.resolvedDocumentId) refInput.resolvedBy = user.id;
    const reference = await graphDb.createReference(refInput);

    return c.json(formatReference(reference), 201);
  } catch (error) {
    console.error('Error creating reference:', error);
    return c.json({ error: 'Failed to create reference' }, 500);
  }
});

// ==========================================
// QUERY REFERENCES
// ==========================================

const queryReferencesRoute = createRoute({
  method: 'get',
  path: '/api/references',
  summary: 'Query References',
  description: 'Query references with filters',
  tags: ['References'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      documentId: z.string().optional(),
      resolvedDocumentId: z.string().optional(),
      provisional: z.string().optional(),
      limit: z.string().optional().default('20'),
      offset: z.string().optional().default('0'),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            references: z.array(ReferenceSchema),
            total: z.number(),
          }),
        },
      },
      description: 'References retrieved successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

referencesRouter.openapi(queryReferencesRoute, async (c) => {
  const query = c.req.valid('query');
  const limit = parseInt(query.limit);
  const offset = parseInt(query.offset);

  const graphDb = await getGraphDatabase();

  const filter: any = {
    limit,
    offset,
  };
  if (query.documentId) filter.documentId = query.documentId;
  if (query.resolvedDocumentId) filter.resolvedDocumentId = query.resolvedDocumentId;
  if (query.provisional !== undefined) filter.provisional = query.provisional === 'true';

  const result = await graphDb.listReferences(filter);

  return c.json({
    references: result.references.map(formatReference),
    total: result.total,
  }, 200);
});

// ==========================================
// RESOLVE REFERENCE
// ==========================================

const resolveReferenceRoute = createRoute({
  method: 'put',
  path: '/api/references/{referenceId}/resolve-to/{documentId}',
  summary: 'Resolve Reference',
  description: 'Simply resolve a reference to a specific document',
  tags: ['References'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      referenceId: z.string(),
      documentId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: ResolveReferenceRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            reference: ReferenceSchema,
            resolvedDocument: DocumentSchema,
          }),
        },
      },
      description: 'Reference resolved successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Reference or document not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

referencesRouter.openapi(resolveReferenceRoute, async (c) => {
  const user = c.get('user');
  const { referenceId, documentId } = c.req.valid('param');
  const body = c.req.valid('json');

  const graphDb = await getGraphDatabase();

  // Verify reference exists
  const reference = await graphDb.getReference(referenceId);

  if (!reference) {
    return c.json({ error: 'Reference not found' }, 404);
  }

  // Verify document exists
  const document = await graphDb.getDocument(documentId);

  if (!document) {
    return c.json({ error: 'Document not found' }, 404);
  }

  // Update reference
  const resolveInput: any = {
    referenceId,
    documentId,
    provisional: false,
    resolvedBy: user.id,
  };
  if (body && body.metadata) {
    if (body.metadata.confidence !== undefined) resolveInput.confidence = body.metadata.confidence;
    if (body.metadata.resolvedBy) resolveInput.resolvedBy = body.metadata.resolvedBy;
    resolveInput.metadata = body.metadata;
  }
  const updatedReference = await graphDb.resolveReference(resolveInput);

  return c.json({
    reference: formatReference(updatedReference),
    resolvedDocument: formatDocument(document),
  }, 200);
});

// ==========================================
// CREATE DOCUMENT FROM REFERENCE (Wiki Red-Link)
// ==========================================

const createDocumentFromReferenceRoute = createRoute({
  method: 'post',
  path: '/api/references/{referenceId}/create-document',
  summary: 'Create Document from Reference',
  description: 'Create a new document from an unresolved reference (Wiki red-link style)',
  tags: ['References'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      referenceId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateDocumentFromReferenceRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateDocumentFromReferenceResponseSchema,
        },
      },
      description: 'Document created successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Reference not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

referencesRouter.openapi(createDocumentFromReferenceRoute, async (c) => {
  const user = c.get('user');
  const { referenceId } = c.req.valid('param');
  const body = c.req.valid('json');

  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  // Get reference with source document
  const reference = await graphDb.getReference(referenceId);
  if (!reference) {
    return c.json({ error: 'Reference not found' }, 404);
  }

  const sourceDocument = await graphDb.getDocument(reference.documentId);
  if (!sourceDocument) {
    return c.json({ error: 'Source document not found' }, 404);
  }

  // Create new document
  const content = body.content || `# ${body.name}\n\nThis document was created from a reference.`;
  const newDocument = await graphDb.createDocument({
    name: body.name,
    entityTypes: body.entityTypes || [],
    content,
    contentType: body.contentType || 'text/plain',
    metadata: body.metadata || {},
    createdBy: user.id,
  });

  // Save content to storage
  await storage.saveDocument(newDocument.id, content);

  // Auto-resolve the reference if requested
  let updatedReference = reference;
  if (body.autoResolve !== false) {
    updatedReference = await graphDb.resolveReference({
      referenceId,
      documentId: newDocument.id,
      provisional: false,
      resolvedBy: user.id,
    });
  }

  // Get source document content for context
  const sourceContent = await storage.getDocument(sourceDocument.id);
  const contextWindow = getContextWindow(sourceContent.toString('utf-8'), reference.referenceData);

  return c.json({
    document: formatDocument(newDocument),
    reference: formatReference(updatedReference),
    sourceContext: {
      document: formatDocument(sourceDocument),
      contextWindow,
    },
  }, 201);
});

// ==========================================
// GENERATE DOCUMENT FROM REFERENCE (AI-Powered)
// ==========================================

const generateDocumentFromReferenceRoute = createRoute({
  method: 'post',
  path: '/api/references/{referenceId}/generate-document',
  summary: 'Generate Document from Reference',
  description: 'Create and generate document content based on reference context',
  tags: ['References'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      referenceId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromReferenceRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromReferenceResponseSchema,
        },
      },
      description: 'Document generated successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Reference not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

referencesRouter.openapi(generateDocumentFromReferenceRoute, async (c) => {
  const user = c.get('user');
  const { referenceId } = c.req.valid('param');
  const body = c.req.valid('json');

  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  // Get reference with source document
  const reference = await graphDb.getReference(referenceId);
  if (!reference) {
    return c.json({ error: 'Reference not found' }, 404);
  }

  const sourceDocument = await graphDb.getDocument(reference.documentId);
  if (!sourceDocument) {
    return c.json({ error: 'Source document not found' }, 404);
  }

  // Get source content for context
  const sourceContent = await storage.getDocument(sourceDocument.id);
  const sourceContentStr = sourceContent.toString('utf-8');

  // Get context around the reference
  const contextBefore = body.contextWindow?.before || 500;
  const contextAfter = body.contextWindow?.after || 500;
  const contextWindow = getContextWindow(
    sourceContentStr,
    reference.referenceData,
    contextBefore,
    contextAfter
  );

  // Generate document name and content (stub - would use AI in real implementation)
  const generatedName = body.name || extractNameFromReference(reference.referenceData);
  const generatedContent = await generateDocumentContent(
    generatedName,
    contextWindow,
    { ...sourceDocument, content: sourceContentStr }
  );

  // Detect entity types (stub - would use NLP in real implementation)
  const detectedEntityTypes = body.entityTypes || detectEntityTypes(generatedContent);

  // Create new document
  const newDocument = await graphDb.createDocument({
    name: generatedName,
    entityTypes: detectedEntityTypes,
    content: generatedContent,
    contentType: 'text/plain',
    metadata: {
      generatedFrom: referenceId,
      sourceDocument: reference.documentId,
    },
    createdBy: user.id,
  });

  // Save content to storage
  await storage.saveDocument(newDocument.id, generatedContent);

  // Auto-resolve the reference if requested
  let updatedReference = reference;
  if (body.autoResolve !== false) {
    updatedReference = await graphDb.resolveReference({
      referenceId,
      documentId: newDocument.id,
      provisional: false,
      confidence: 0.9,
      resolvedBy: user.id,
    });
  }

  // Find suggested links (stub)
  const suggestedLinks = await findSuggestedLinks(newDocument);

  return c.json({
    document: formatDocument(newDocument),
    reference: formatReference(updatedReference),
    generationMetadata: {
      contextUsed: contextWindow,
      confidence: 0.85,
      suggestedLinks,
    },
  }, 201);
});

// ==========================================
// GET REFERENCE CONTEXT
// ==========================================

const getReferenceContextRoute = createRoute({
  method: 'get',
  path: '/api/references/{referenceId}/context',
  summary: 'Get Reference Context',
  description: 'Get the context around a reference',
  tags: ['References'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      referenceId: z.string(),
    }),
    query: z.object({
      windowSize: z.string().optional().default('500'),
      includeStructure: z.string().optional().default('false'),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ReferenceContextResponseSchema,
        },
      },
      description: 'Context retrieved successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Reference not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

referencesRouter.openapi(getReferenceContextRoute, async (c) => {
  const { referenceId } = c.req.valid('param');
  const query = c.req.valid('query');
  const windowSize = parseInt(query.windowSize);

  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const reference = await graphDb.getReference(referenceId);
  if (!reference) {
    return c.json({ error: 'Reference not found' }, 404);
  }

  const document = await graphDb.getDocument(reference.documentId);
  if (!document) {
    return c.json({ error: 'Document not found' }, 404);
  }

  // Get document content from storage
  const content = await storage.getDocument(document.id);
  const contentStr = content.toString('utf-8');

  const context = extractContext(
    contentStr,
    reference.referenceData,
    windowSize
  );

  // Find nearby references if requested
  let nearbyReferences = undefined;
  if (query.includeStructure === 'true') {
    const allRefs = await graphDb.getDocumentReferences(reference.documentId);
    const filteredRefs = allRefs.filter(ref => ref.id !== referenceId);
    nearbyReferences = findNearbyReferences(reference, filteredRefs);
  }

  return c.json({
    reference: formatReference(reference),
    sourceDocument: formatDocument(document),
    context: {
      ...context,
      nearbyReferences,
    },
  }, 200);
});

// ==========================================
// DELETE REFERENCE
// ==========================================

const deleteReferenceRoute = createRoute({
  method: 'delete',
  path: '/api/references/{id}',
  summary: 'Delete Reference',
  description: 'Delete a reference',
  tags: ['References'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    204: {
      description: 'Reference deleted successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Reference not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

referencesRouter.openapi(deleteReferenceRoute, async (c) => {
  const { id } = c.req.valid('param');

  const graphDb = await getGraphDatabase();
  await graphDb.deleteReference(id);

  return c.body(null, 204);
});

// ==========================================
// CONTEXTUAL SUMMARY
// ==========================================

const getContextualSummaryRoute = createRoute({
  method: 'get',
  path: '/api/documents/{documentId}/summary-for-reference/{referenceId}',
  summary: 'Get Contextual Summary',
  description: 'Get a context-aware summary of a document tailored to a specific reference',
  tags: ['References'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      documentId: z.string(),
      referenceId: z.string(),
    }),
    query: z.object({
      maxLength: z.string().optional().default('500'),
      format: z.enum(['text', 'structured', 'markdown']).optional().default('structured'),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ContextualSummaryResponseSchema,
        },
      },
      description: 'Summary generated successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document or reference not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

referencesRouter.openapi(getContextualSummaryRoute, async (c) => {
  const { documentId, referenceId } = c.req.valid('param');
  const query = c.req.valid('query');

  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  // Get document and reference
  const [document, reference] = await Promise.all([
    graphDb.getDocument(documentId),
    graphDb.getReference(referenceId),
  ]);

  if (!document || !reference) {
    return c.json({ error: 'Document or reference not found' }, 404);
  }

  // Get reference source document
  const sourceDocument = await graphDb.getDocument(reference.documentId);
  if (!sourceDocument) {
    return c.json({ error: 'Source document not found' }, 404);
  }

  // Get document content from storage
  const content = await storage.getDocument(document.id);
  const contentStr = content.toString('utf-8');

  // Generate contextual summary (stub - would use AI in real implementation)
  const summary = await generateContextualSummary(
    { ...document, content: contentStr },
    { ...reference, document: sourceDocument },
    parseInt(query.maxLength),
    query.format as any
  );

  return c.json(summary, 200);
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function formatDocument(doc: Document): any {
  return {
    id: doc.id,
    name: doc.name,
    entityTypes: doc.entityTypes,
    contentType: doc.contentType,
    metadata: doc.metadata,
    storageUrl: doc.storageUrl,
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  };
}

function formatReference(ref: Reference): any {
  return {
    id: ref.id,
    documentId: ref.documentId,
    referenceType: ref.referenceType,
    referenceData: ref.referenceData,
    resolvedDocumentId: ref.resolvedDocumentId,
    provisional: ref.provisional,
    confidence: ref.confidence,
    metadata: ref.metadata,
    resolvedBy: ref.resolvedBy,
    resolvedAt: ref.resolvedAt instanceof Date ? ref.resolvedAt.toISOString() : ref.resolvedAt,
    createdAt: ref.createdAt instanceof Date ? ref.createdAt.toISOString() : ref.createdAt,
    updatedAt: ref.updatedAt instanceof Date ? ref.updatedAt.toISOString() : ref.updatedAt,
  };
}

function getContextWindow(
  content: string,
  referenceData: any,
  before: number = 500,
  after: number = 500
): string {
  if (referenceData.type === 'text_span') {
    const start = Math.max(0, referenceData.offset - before);
    const end = Math.min(content.length, referenceData.offset + referenceData.length + after);
    return content.substring(start, end);
  }
  
  // For other reference types, return a placeholder
  return `[Context for ${referenceData.type} reference]`;
}

function extractContext(
  content: string,
  referenceData: any,
  windowSize: number
): any {
  if (referenceData.type === 'text_span') {
    const offset = referenceData.offset;
    const length = referenceData.length;
    
    const beforeStart = Math.max(0, offset - windowSize);
    const afterEnd = Math.min(content.length, offset + length + windowSize);
    
    return {
      before: content.substring(beforeStart, offset),
      referenceContent: content.substring(offset, offset + length),
      after: content.substring(offset + length, afterEnd),
    };
  }
  
  return {
    before: '',
    referenceContent: '[Reference content]',
    after: '',
  };
}

function extractNameFromReference(referenceData: any): string {
  if (referenceData.type === 'text_span' && referenceData.text) {
    return referenceData.text;
  }
  return 'Generated Document';
}

async function generateDocumentContent(
  name: string,
  context: string,
  sourceDocument: any
): Promise<string> {
  // Stub implementation - would use AI/LLM in real implementation
  return `# ${name}

This document was automatically generated based on a reference from "${sourceDocument.name}".

## Context

The reference appeared in the following context:

> ${context.substring(0, 500)}...

## Overview

[AI-generated content would go here based on the context and reference]

## Related Topics

- ${sourceDocument.name}
- [Other related documents would be listed here]

---

*This is a stub implementation. In production, this would use AI to generate meaningful content based on the reference context.*`;
}

function detectEntityTypes(content: string): string[] {
  // Stub implementation - would use NLP in real implementation
  const types = ['Topic'];
  
  // Simple heuristics
  if (content.toLowerCase().includes('person') || content.toLowerCase().includes('author')) {
    types.push('Person');
  }
  if (content.toLowerCase().includes('technology') || content.toLowerCase().includes('software')) {
    types.push('Technology');
  }
  if (content.toLowerCase().includes('organization') || content.toLowerCase().includes('company')) {
    types.push('Organization');
  }
  
  return types;
}

async function findSuggestedLinks(_document: any): Promise<any[]> {
  // Stub implementation - would use semantic search in real implementation
  return [
    {
      documentId: 'doc_related_1',
      documentName: 'Related Topic 1',
      relevance: 0.85,
    },
    {
      documentId: 'doc_related_2',
      documentName: 'Related Topic 2',
      relevance: 0.72,
    },
  ];
}

function findNearbyReferences(targetRef: any, allRefs: any[]): any[] {
  if (targetRef.referenceData.type !== 'text_span') {
    return [];
  }
  
  const targetOffset = targetRef.referenceData.offset;
  
  return allRefs
    .filter(ref => ref.referenceData.type === 'text_span')
    .map(ref => ({
      reference: formatReference(ref),
      distance: Math.abs(ref.referenceData.offset - targetOffset),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5); // Return 5 nearest references
}

async function generateContextualSummary(
  document: any,
  reference: any,
  maxLength: number,
  format: 'text' | 'structured' | 'markdown'
): Promise<any> {
  // Stub implementation - would use AI in real implementation
  const contextWindow = getContextWindow(reference.document.content || '', reference.referenceData);
  
  const summary = {
    title: document.name,
    briefDescription: `${document.name} is a document about ${document.entityTypes.join(', ') || 'various topics'}.`,
    fields: {
      type: document.entityTypes[0] || 'Document',
      contentType: document.contentType,
      created: document.createdAt instanceof Date ? document.createdAt.toISOString() : document.createdAt,
      wordCount: document.content ? document.content.split(/\s+/).length : 0,
    },
    relevantSections: [
      {
        heading: 'Main Content',
        content: document.content ? document.content.substring(0, 200) + '...' : '',
        relevance: 0.9,
      },
    ],
    relatedDocuments: [],
  };
  
  return {
    summary,
    metadata: {
      documentId: document.id,
      referenceId: reference.id,
      referenceContext: {
        sourceDocument: formatDocument(reference.document),
        contextWindow,
      },
      generatedAt: new Date().toISOString(),
    },
  };
}