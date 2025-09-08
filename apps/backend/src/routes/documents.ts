import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { authMiddleware } from '../middleware/auth';
import { User } from '@prisma/client';
import { ErrorResponseSchema } from '../openapi';
import {
  DocumentSchema,
  CreateDocumentRequestSchema,
  CreateDocumentResponseSchema,
  GetDocumentResponseSchema,
  ListDocumentsResponseSchema,
  UpdateDocumentRequestSchema,
  DetectReferencesRequestSchema,
  DetectReferencesResponseSchema,
} from '../schemas/document-schemas';
import { getGraphDatabase } from '../graph/factory';
import { getStorageService } from '../storage/filesystem';
import type { Document, Reference } from '../graph/types';

// Create documents router
export const documentsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth middleware to all document routes
documentsRouter.use('/api/documents/*', authMiddleware);

// ==========================================
// CREATE DOCUMENT
// ==========================================

const createDocumentRoute = createRoute({
  method: 'post',
  path: '/api/documents',
  summary: 'Create Document',
  description: 'Create a new document with optional initial references',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateDocumentRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateDocumentResponseSchema,
        },
      },
      description: 'Document created successfully',
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

documentsRouter.openapi(createDocumentRoute, async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  try {
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    // Create document in graph database
    const document = await graphDb.createDocument({
      name: body.name,
      entityTypes: body.entityTypes || [],
      content: body.content,
      contentType: body.contentType || 'text/plain',
      metadata: body.metadata || {},
      createdBy: user.id,
    });

    // Save content to filesystem
    const storageUrl = await storage.saveDocument(document.id, body.content);
    
    // Update document with storage URL
    const updatedDocument = await graphDb.updateDocument(document.id, {
      metadata: { ...document.metadata, storageUrl },
      updatedBy: user.id,
    });

    // Create initial references if provided
    const references: Reference[] = [];
    if (body.references && body.references.length > 0) {
      for (const refData of body.references) {
        const refInput: any = {
          documentId: document.id,
          referenceType: refData.referenceType.type,
          referenceData: refData.referenceType,
          provisional: refData.provisional || false,
        };
        if (refData.resolvedDocumentId) refInput.resolvedDocumentId = refData.resolvedDocumentId;
        if (refData.confidence !== undefined) refInput.confidence = refData.confidence;
        if (refData.metadata) refInput.metadata = refData.metadata;
        if (refData.resolvedDocumentId) refInput.resolvedBy = user.id;
        const reference = await graphDb.createReference(refInput);
        references.push(reference);
      }
    }

    return c.json({
      document: formatDocument(updatedDocument),
      references: references.map(formatReference),
    }, 201);
  } catch (error) {
    console.error('Error creating document:', error);
    return c.json({ error: 'Failed to create document' }, 500);
  }
});

// ==========================================
// GET DOCUMENT
// ==========================================

const getDocumentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}',
  summary: 'Get Document',
  description: 'Retrieve a document by ID with its references',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GetDocumentResponseSchema,
        },
      },
      description: 'Document retrieved successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
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

documentsRouter.openapi(getDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');

  const graphDb = await getGraphDatabase();
  const document = await graphDb.getDocument(id);

  if (!document) {
    return c.json({ error: 'Document not found' }, 404);
  }

  const references = await graphDb.getDocumentReferences(id);
  const referencedBy = await graphDb.getDocumentReferencedBy(id);

  return c.json({
    document: formatDocument(document),
    references: references.map(formatReference),
    referencedBy: referencedBy.map(formatReference),
  }, 200);
});

// ==========================================
// LIST DOCUMENTS
// ==========================================

const listDocumentsRoute = createRoute({
  method: 'get',
  path: '/api/documents',
  summary: 'List Documents',
  description: 'List and search documents',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      entityTypes: z.string().optional().openapi({ example: 'Person,Author' }),
      search: z.string().optional().openapi({ example: 'quantum' }),
      limit: z.string().optional().default('20').openapi({ example: '20' }),
      offset: z.string().optional().default('0').openapi({ example: '0' }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListDocumentsResponseSchema,
        },
      },
      description: 'Documents retrieved successfully',
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

documentsRouter.openapi(listDocumentsRoute, async (c) => {
  const query = c.req.valid('query');
  const limit = parseInt(query.limit);
  const offset = parseInt(query.offset);

  const graphDb = await getGraphDatabase();

  // Build filter for graph database
  const filter = {
    entityTypes: query.entityTypes ? query.entityTypes.split(',').map(t => t.trim()) : undefined,
    search: query.search,
    limit,
    offset,
  };

  const result = await graphDb.listDocuments(filter);

  return c.json({
    documents: result.documents.map(formatDocument),
    total: result.total,
  }, 200);
});

// ==========================================
// UPDATE DOCUMENT
// ==========================================

const updateDocumentRoute = createRoute({
  method: 'put',
  path: '/api/documents/{id}',
  summary: 'Update Document',
  description: 'Update document metadata (not content)',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateDocumentRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DocumentSchema,
        },
      },
      description: 'Document updated successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
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

documentsRouter.openapi(updateDocumentRoute, async (c) => {
  const user = c.get('user');
  const { id } = c.req.valid('param');
  const body = c.req.valid('body');

  const graphDb = await getGraphDatabase();
  const document = await graphDb.updateDocument(id, {
    name: body.name,
    entityTypes: body.entityTypes,
    metadata: body.metadata,
    updatedBy: user.id,
  });

  return c.json(formatDocument(document), 200);
});

// ==========================================
// DELETE DOCUMENT
// ==========================================

const deleteDocumentRoute = createRoute({
  method: 'delete',
  path: '/api/documents/{id}',
  summary: 'Delete Document',
  description: 'Delete a document and all its references',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
  },
  responses: {
    204: {
      description: 'Document deleted successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
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

documentsRouter.openapi(deleteDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');

  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  // Delete from graph database (will also delete references)
  await graphDb.deleteDocument(id);

  // Delete from storage
  await storage.deleteDocument(id);

  return c.body(null, 204);
});

// ==========================================
// DETECT REFERENCES
// ==========================================

const detectReferencesRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/detect-references',
  summary: 'Detect References',
  description: 'Trigger reference detection for a document',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
    body: {
      content: {
        'application/json': {
          schema: DetectReferencesRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DetectReferencesResponseSchema,
        },
      },
      description: 'References detected successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
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

documentsRouter.openapi(detectReferencesRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('body');

  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  const document = await graphDb.getDocument(id);

  if (!document) {
    return c.json({ error: 'Document not found' }, 404);
  }

  // Get document content from storage
  const content = await storage.getDocument(id);
  const contentStr = content.toString('utf-8');

  // Stub implementation - in real implementation, this would:
  // 1. Use NLP/ML to detect references in the document
  // 2. Find potential resolutions from existing documents
  // 3. Return detected references with confidence scores

  const detectedReferences = await detectReferencesInDocument(
    { ...document, content: contentStr },
    body.includeProvisional || true,
    body.confidenceThreshold || 0.5
  );

  return c.json({
    references: detectedReferences,
  }, 200);
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


// Stub for detecting references in document
async function detectReferencesInDocument(
  document: any,
  includeProvisional: boolean,
  confidenceThreshold: number
): Promise<any[]> {
  // Stub implementation
  // In real implementation, this would:
  // 1. Parse document content based on contentType
  // 2. Use NLP/ML to detect potential references
  // 3. Search for matching documents in the database
  // 4. Return references with suggested resolutions

  const stubReferences = [];

  // Example: detect simple [[wiki-style]] references in text
  if (document.contentType === 'text/plain' || document.contentType === 'text/markdown') {
    const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
    let match;
    
    while ((match = wikiLinkPattern.exec(document.content)) !== null) {
      const referenceText = match[1];
      const offset = match.index;
      const length = match[0].length;

      // Create a reference
      const reference = {
        reference: {
          id: `ref_stub_${Math.random().toString(36).substr(2, 9)}`,
          documentId: document.id,
          referenceType: 'text_span',
          referenceData: {
            type: 'text_span',
            offset,
            length,
            text: referenceText,
          },
          resolvedDocumentId: null,
          provisional: false,
          confidence: null,
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        suggestedResolutions: includeProvisional ? [
          {
            documentId: 'doc_suggested_' + Math.random().toString(36).substr(2, 9),
            documentName: referenceText,
            entityTypes: ['Topic'],
            confidence: 0.75,
            reason: 'Name similarity match',
          }
        ] : undefined,
      };

      if (!includeProvisional || (reference.suggestedResolutions && reference.suggestedResolutions[0].confidence >= confidenceThreshold)) {
        stubReferences.push(reference);
      }
    }
  }

  return stubReferences;
}