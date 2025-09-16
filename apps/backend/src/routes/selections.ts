import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { authMiddleware } from '../middleware/auth';
import { User } from '@prisma/client';
import { ErrorResponseSchema } from '../openapi';
import { getGraphDatabase } from '../graph/factory';
import { getStorageService } from '../storage/filesystem';
import type { Document, Selection } from '../graph/types';
import {
  SelectionSchema,
  CreateSelectionRequestSchema,
  ResolveSelectionRequestSchema,
  CreateDocumentFromSelectionRequestSchema,
  CreateDocumentFromSelectionResponseSchema,
  GenerateDocumentFromSelectionRequestSchema,
  GenerateDocumentFromSelectionResponseSchema,
  ContextualSummaryResponseSchema,
  SelectionContextResponseSchema,
} from '../schemas/document-schemas';

// Create selections router
export const selectionsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth middleware to all selection routes
selectionsRouter.use('/api/selections/*', authMiddleware);

// Apply auth middleware to tag management routes
selectionsRouter.use('/api/entity-types', authMiddleware);
selectionsRouter.use('/api/entity-types/*', authMiddleware);
selectionsRouter.use('/api/reference-types', authMiddleware);
selectionsRouter.use('/api/reference-types/*', authMiddleware);

// ==========================================
// CREATE SELECTION
// ==========================================

const createSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections',
  summary: 'Create Selection',
  description: 'Create a selection (highlight if no resolvedDocumentId, reference if resolvedDocumentId present)',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateSelectionRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: SelectionSchema,
        },
      },
      description: 'Selection created successfully',
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
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(createSelectionRoute, async (c) => {
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

    const selInput: any = {
      documentId: body.documentId,
      selectionType: body.selectionType.type,
      selectionData: body.selectionType,
      referenceTags: body.referenceTags,
      entityTypes: body.entityTypes,
      metadata: body.metadata,
    };
    
    // Only include resolvedDocumentId if it's explicitly provided AND not undefined
    if ('resolvedDocumentId' in body && body.resolvedDocumentId !== undefined) {
      selInput.resolvedDocumentId = body.resolvedDocumentId;
      if (body.resolvedDocumentId) {
        selInput.resolvedBy = user.id;
      }
    }

    const selection = await graphDb.createSelection(selInput);

    return c.json(formatSelection(selection), 201);
  } catch (error) {
    console.error('Error creating selection:', error);
    return c.json({ error: 'Failed to create selection' }, 500);
  }
});

// ==========================================
// GET SELECTION
// ==========================================

const getSelectionRoute = createRoute({
  method: 'get',
  path: '/api/selections/{id}',
  summary: 'Get Selection',
  description: 'Get a specific selection by ID',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'sel_xyz789' }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: SelectionSchema,
        },
      },
      description: 'Selection found',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Selection not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(getSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');

  try {
    const graphDb = await getGraphDatabase();
    const selection = await graphDb.getSelection(id);

    if (!selection) {
      return c.json({ error: 'Selection not found' }, 404);
    }

    return c.json(formatSelection(selection), 200);
  } catch (error) {
    console.error('Error fetching selection:', error);
    return c.json({ error: 'Failed to fetch selection' }, 500);
  }
});

// ==========================================
// LIST SELECTIONS
// ==========================================

const listSelectionsRoute = createRoute({
  method: 'get',
  path: '/api/selections',
  summary: 'List Selections',
  description: 'List selections with optional filters',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      documentId: z.string().optional(),
      resolvedDocumentId: z.string().optional(),
      resolved: z.boolean().optional(),
      hasEntityTypes: z.boolean().optional(),
      referenceTags: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            selections: z.array(SelectionSchema),
            total: z.number(),
          }),
        },
      },
      description: 'Selections list',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(listSelectionsRoute, async (c) => {
  const query = c.req.valid('query');

  try {
    const graphDb = await getGraphDatabase();
    const filter: any = {
      limit: query.limit,
      offset: query.offset,
    };
    if (query.documentId !== undefined) filter.documentId = query.documentId;
    if (query.resolvedDocumentId !== undefined) filter.resolvedDocumentId = query.resolvedDocumentId;
    if (query.resolved !== undefined) filter.resolved = query.resolved;
    if (query.hasEntityTypes !== undefined) filter.hasEntityTypes = query.hasEntityTypes;
    if (query.referenceTags) filter.referenceTags = query.referenceTags.split(',');
    
    const result = await graphDb.listSelections(filter);

    return c.json({
      selections: result.selections.map(formatSelection),
      total: result.total,
    }, 200);
  } catch (error) {
    console.error('Error listing selections:', error);
    return c.json({ error: 'Failed to list selections' }, 500);
  }
});

// ==========================================
// RESOLVE SELECTION (Make it a Reference)
// ==========================================

const resolveSelectionRoute = createRoute({
  method: 'put',
  path: '/api/selections/{id}/resolve',
  summary: 'Resolve Selection to Document',
  description: 'Resolve a selection to a document (make it a reference)',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: ResolveSelectionRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: SelectionSchema,
        },
      },
      description: 'Selection resolved as reference',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Selection or document not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(resolveSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  try {
    const graphDb = await getGraphDatabase();
    
    const selection = await graphDb.getSelection(id);
    if (!selection) {
      return c.json({ error: 'Selection not found' }, 404);
    }

    const targetDoc = await graphDb.getDocument(body.documentId);
    if (!targetDoc) {
      return c.json({ error: 'Target document not found' }, 404);
    }

    const resolveInput: any = {
      selectionId: id,
      documentId: body.documentId,
      resolvedBy: user.id,
    };
    if (body.referenceTags !== undefined) resolveInput.referenceTags = body.referenceTags;
    if (body.entityTypes !== undefined) resolveInput.entityTypes = body.entityTypes;
    if (body.provisional !== undefined) resolveInput.provisional = body.provisional;
    if (body.confidence !== undefined) resolveInput.confidence = body.confidence;
    if (body.metadata !== undefined) resolveInput.metadata = body.metadata;
    
    const updated = await graphDb.resolveSelection(resolveInput);

    return c.json(formatSelection(updated), 200);
  } catch (error) {
    console.error('Error resolving selection:', error);
    return c.json({ error: 'Failed to resolve selection' }, 500);
  }
});

// ==========================================
// CREATE DOCUMENT FROM SELECTION
// ==========================================

const createDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections/{id}/create-document',
  summary: 'Create Document from Selection',
  description: 'Create a new document from a selection and resolve the selection to it',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateDocumentFromSelectionRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateDocumentFromSelectionResponseSchema,
        },
      },
      description: 'Document created and selection resolved',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Selection not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(createDocumentFromSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  try {
    const graphDb = await getGraphDatabase();
    const storage = await getStorageService() as any;
    
    const selection = await graphDb.getSelection(id);
    if (!selection) {
      return c.json({ error: 'Selection not found' }, 404);
    }

    // Create the new document
    const createDocInput: any = {
      name: body.name,
      content: body.content || '',
      contentType: body.contentType,
      createdBy: user.id,
    };
    if (body.entityTypes !== undefined) createDocInput.entityTypes = body.entityTypes;
    if (body.metadata !== undefined) createDocInput.metadata = body.metadata;
    
    const document = await graphDb.createDocument(createDocInput);

    // Store content if provided
    if (body.content) {
      await storage.saveDocument(document.id, body.content);
    }

    // Resolve the selection to the new document
    const updatedSelection = await graphDb.resolveSelection({
      selectionId: id,
      documentId: document.id,
      resolvedBy: user.id,
    });

    return c.json({
      document: formatDocumentWithContent(document, body.content || ''),
      selection: formatSelection(updatedSelection),
    }, 201);
  } catch (error) {
    console.error('Error creating document from selection:', error);
    return c.json({ error: 'Failed to create document from selection' }, 500);
  }
});

// ==========================================
// GENERATE DOCUMENT FROM SELECTION
// ==========================================

const generateDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections/{id}/generate-document',
  summary: 'Generate Document from Selection',
  description: 'Use AI to generate document content from a selection',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromSelectionRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromSelectionResponseSchema,
        },
      },
      description: 'Document generated and selection resolved',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Selection not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(generateDocumentFromSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  try {
    const graphDb = await getGraphDatabase();
    const storage = await getStorageService() as any;
    
    const selection = await graphDb.getSelection(id);
    if (!selection) {
      return c.json({ error: 'Selection not found' }, 404);
    }

    // Get the source document content
    const sourceDoc = await graphDb.getDocument(selection.documentId);
    if (!sourceDoc) {
      return c.json({ error: 'Source document not found' }, 404);
    }

    // const sourceContent = await storage.getDocument(sourceDoc.id);

    // Dummy implementation: Generate Lorem ipsum content
    const generatedContent = generateDummyContent(
      selection,
      sourceDoc,
      body.prompt,
      body.name
    );

    // Create the new document
    const document = await graphDb.createDocument({
      name: body.name || `Generated from ${sourceDoc.name}`,
      entityTypes: body.entityTypes || sourceDoc.entityTypes,
      content: generatedContent,
      contentType: 'text/plain',
      metadata: {
        generatedFrom: selection.id,
        sourceDocument: sourceDoc.id,
        prompt: body.prompt,
      },
      createdBy: user.id,
    });

    // Store the generated content
    await storage.saveDocument(document.id, generatedContent);

    // Resolve the selection to the new document
    const updatedSelection = await graphDb.resolveSelection({
      selectionId: id,
      documentId: document.id,
      resolvedBy: user.id,
    });

    return c.json({
      document: formatDocumentWithContent(document, generatedContent),
      selection: formatSelection(updatedSelection),
      generated: true,
    }, 201);
  } catch (error) {
    console.error('Error generating document from selection:', error);
    return c.json({ error: 'Failed to generate document from selection' }, 500);
  }
});

// ==========================================
// GET SELECTION CONTEXT
// ==========================================

const getSelectionContextRoute = createRoute({
  method: 'get',
  path: '/api/selections/{id}/context',
  summary: 'Get Selection Context',
  description: 'Get the context around a selection',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: z.object({
      contextBefore: z.number().int().min(0).max(5000).default(100),
      contextAfter: z.number().int().min(0).max(5000).default(100),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: SelectionContextResponseSchema,
        },
      },
      description: 'Selection context',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Selection not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(getSelectionContextRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { contextBefore, contextAfter } = c.req.valid('query');

  try {
    const graphDb = await getGraphDatabase();
    const storage = await getStorageService() as any;
    
    const selection = await graphDb.getSelection(id);
    if (!selection) {
      return c.json({ error: 'Selection not found' }, 404);
    }

    const document = await graphDb.getDocument(selection.documentId);
    if (!document) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const contentBuffer = await storage.getDocument(document.id);
    const content = contentBuffer.toString('utf-8');

    // Extract context based on selection type
    let context = {
      before: '',
      selected: '',
      after: '',
    };

    if (selection.selectionType === 'text_span') {
      const data = selection.selectionData as any;
      const start = Math.max(0, data.offset - contextBefore);
      const end = Math.min(content.length, data.offset + data.length + contextAfter);
      
      context = {
        before: content.substring(start, data.offset),
        selected: content.substring(data.offset, data.offset + data.length),
        after: content.substring(data.offset + data.length, end),
      };
    }

    return c.json({
      selection: formatSelection(selection),
      context,
      document: formatDocumentWithContent(document, content.toString('utf-8')),
    }, 200);
  } catch (error) {
    console.error('Error getting selection context:', error);
    return c.json({ error: 'Failed to get selection context' }, 500);
  }
});

// ==========================================
// GET CONTEXTUAL SUMMARY
// ==========================================

const getContextualSummaryRoute = createRoute({
  method: 'get',
  path: '/api/selections/{id}/summary',
  summary: 'Get Contextual Summary',
  description: 'Get an AI-generated summary of the selection in context',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ContextualSummaryResponseSchema,
        },
      },
      description: 'Contextual summary',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Selection not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(getContextualSummaryRoute, async (c) => {
  const { id } = c.req.valid('param');

  try {
    const graphDb = await getGraphDatabase();
    const storage = await getStorageService() as any;
    
    const selection = await graphDb.getSelection(id);
    if (!selection) {
      return c.json({ error: 'Selection not found' }, 404);
    }

    const document = await graphDb.getDocument(selection.documentId);
    if (!document) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const contentBuffer = await storage.getDocument(document.id);
    const content = contentBuffer.toString('utf-8');

    // Extract context
    let context = {
      before: '',
      selected: '',
      after: '',
    };

    if (selection.selectionType === 'text_span') {
      const data = selection.selectionData as any;
      const contextSize = 500;
      const start = Math.max(0, data.offset - contextSize);
      const end = Math.min(content.length, data.offset + data.length + contextSize);
      
      context = {
        before: content.substring(start, data.offset),
        selected: content.substring(data.offset, data.offset + data.length),
        after: content.substring(data.offset + data.length, end),
      };
    }

    // TODO: Call AI service to generate summary
    // For now, return a placeholder
    const summary = `Summary of selection from "${document.name}": ${context.selected.substring(0, 100)}...`;

    return c.json({
      summary,
      relevantFields: {
        documentName: document.name,
        entityTypes: document.entityTypes,
        selectionType: selection.selectionType,
      },
      context,
    }, 200);
  } catch (error) {
    console.error('Error getting contextual summary:', error);
    return c.json({ error: 'Failed to get contextual summary' }, 500);
  }
});

// ==========================================
// DELETE SELECTION
// ==========================================

const deleteSelectionRoute = createRoute({
  method: 'delete',
  path: '/api/selections/{id}',
  summary: 'Delete Selection',
  description: 'Delete a selection',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    204: {
      description: 'Selection deleted successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Selection not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(deleteSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');

  try {
    const graphDb = await getGraphDatabase();
    
    const selection = await graphDb.getSelection(id);
    if (!selection) {
      return c.json({ error: 'Selection not found' }, 404);
    }

    await graphDb.deleteSelection(id);
    
    return c.body(null, 204);
  } catch (error) {
    console.error('Error deleting selection:', error);
    return c.json({ error: 'Failed to delete selection' }, 500);
  }
});

// ==========================================
// GET DOCUMENT SELECTIONS
// ==========================================

const getDocumentSelectionsRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/selections',
  summary: 'Get Document Selections',
  description: 'Get all selections in a document',
  tags: ['Documents', 'Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            selections: z.array(SelectionSchema),
          }),
        },
      },
      description: 'Document selections',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(getDocumentSelectionsRoute, async (c) => {
  const { id } = c.req.valid('param');

  try {
    const graphDb = await getGraphDatabase();
    
    const document = await graphDb.getDocument(id);
    if (!document) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const selections = await graphDb.getDocumentSelections(id);
    
    return c.json({ selections: selections.map(formatSelection) }, 200);
  } catch (error) {
    console.error('Error getting document selections:', error);
    return c.json({ error: 'Failed to get document selections' }, 500);
  }
});

// ==========================================
// GET DOCUMENT HIGHLIGHTS
// ==========================================

const getDocumentHighlightsRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/highlights',
  summary: 'Get Document Highlights',
  description: 'Get only highlights (selections without resolvedDocumentId) in a document',
  tags: ['Documents', 'Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            highlights: z.array(SelectionSchema),
          }),
        },
      },
      description: 'Document highlights',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(getDocumentHighlightsRoute, async (c) => {
  const { id } = c.req.valid('param');

  try {
    const graphDb = await getGraphDatabase();
    
    const document = await graphDb.getDocument(id);
    if (!document) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const highlights = await graphDb.getHighlights(id);
    
    return c.json({ highlights: highlights.map(formatSelection) }, 200);
  } catch (error) {
    console.error('Error getting document highlights:', error);
    return c.json({ error: 'Failed to get document highlights' }, 500);
  }
});

// ==========================================
// GET DOCUMENT REFERENCES
// ==========================================

const getDocumentReferencesRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/references',
  summary: 'Get Document References',
  description: 'Get only resolved selections (references) in a document',
  tags: ['Documents', 'Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            references: z.array(SelectionSchema),
          }),
        },
      },
      description: 'Document references',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(getDocumentReferencesRoute, async (c) => {
  const { id } = c.req.valid('param');

  try {
    const graphDb = await getGraphDatabase();
    
    const document = await graphDb.getDocument(id);
    if (!document) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const references = await graphDb.getReferences(id);
    
    return c.json({ references: references.map(formatSelection) }, 200);
  } catch (error) {
    console.error('Error getting document references:', error);
    return c.json({ error: 'Failed to get document references' }, 500);
  }
});

// ==========================================
// GET DOCUMENT REFERENCED BY
// ==========================================

const getDocumentReferencedByRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/referenced-by',
  summary: 'Get Incoming References',
  description: 'Get selections from other documents that reference this document',
  tags: ['Documents', 'Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            referencedBy: z.array(SelectionSchema),
          }),
        },
      },
      description: 'Incoming references',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

selectionsRouter.openapi(getDocumentReferencedByRoute, async (c) => {
  const { id } = c.req.valid('param');

  try {
    const graphDb = await getGraphDatabase();
    
    const document = await graphDb.getDocument(id);
    if (!document) {
      return c.json({ error: 'Document not found' }, 404);
    }

    const referencedBy = await graphDb.getDocumentReferencedBy(id);
    
    // Enhance each selection with the source document name
    const enhancedReferences = await Promise.all(
      referencedBy.map(async (sel) => {
        const sourceDoc = await graphDb.getDocument(sel.documentId);
        return {
          ...formatSelection(sel),
          documentName: sourceDoc?.name || 'Untitled Document'
        };
      })
    );
    
    return c.json({ referencedBy: enhancedReferences }, 200);
  } catch (error) {
    console.error('Error getting incoming references:', error);
    return c.json({ error: 'Failed to get incoming references' }, 500);
  }
});

// ==========================================
// GET ENTITY TYPES
// ==========================================

const getEntityTypesRoute = createRoute({
  method: 'get',
  path: '/api/entity-types',
  summary: 'Get Entity Types',
  description: 'Get list of available entity types for references',
  tags: ['Selections'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            entityTypes: z.array(z.string()),
          }),
        },
      },
      description: 'Entity types retrieved successfully',
    },
  },
});

selectionsRouter.openapi(getEntityTypesRoute, async (c) => {
  const graphDb = await getGraphDatabase();
  const entityTypes = await graphDb.getEntityTypes();
  return c.json({ entityTypes }, 200);
});

// ==========================================
// GET REFERENCE TYPES
// ==========================================

const getReferenceTypesRoute = createRoute({
  method: 'get',
  path: '/api/reference-types',
  summary: 'Get Reference Types',
  description: 'Get list of available reference types',
  tags: ['Selections'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            referenceTypes: z.array(z.string()),
          }),
        },
      },
      description: 'Reference types retrieved successfully',
    },
  },
});

selectionsRouter.openapi(getReferenceTypesRoute, async (c) => {
  const graphDb = await getGraphDatabase();
  const referenceTypes = await graphDb.getReferenceTypes();
  return c.json({ referenceTypes }, 200);
});

// ==========================================
// ADD ENTITY TYPE
// ==========================================

const addEntityTypeRoute = createRoute({
  method: 'post',
  path: '/api/entity-types',
  summary: 'Add Entity Type',
  description: 'Add a new entity type to the collection (append-only, requires moderator/admin)',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            tag: z.string().min(1).max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            entityTypes: z.array(z.string()),
          }),
        },
      },
      description: 'Entity type added successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Forbidden - Moderator or Admin access required',
    },
  },
});

selectionsRouter.openapi(addEntityTypeRoute, async (c) => {
  // Check moderation permissions
  const user = c.get('user');
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }
  
  const { tag } = c.req.valid('json');
  const graphDb = await getGraphDatabase();
  
  await graphDb.addEntityType(tag);
  const entityTypes = await graphDb.getEntityTypes();
  
  return c.json({ success: true, entityTypes }, 200);
});

// ==========================================
// ADD REFERENCE TYPE
// ==========================================

const addReferenceTypeRoute = createRoute({
  method: 'post',
  path: '/api/reference-types',
  summary: 'Add Reference Type',
  description: 'Add a new reference type to the collection (append-only, requires moderator/admin)',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            tag: z.string().min(1).max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            referenceTypes: z.array(z.string()),
          }),
        },
      },
      description: 'Reference type added successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Forbidden - Moderator or Admin access required',
    },
  },
});

selectionsRouter.openapi(addReferenceTypeRoute, async (c) => {
  // Check moderation permissions
  const user = c.get('user');
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }
  
  const { tag } = c.req.valid('json');
  const graphDb = await getGraphDatabase();
  
  await graphDb.addReferenceType(tag);
  const referenceTypes = await graphDb.getReferenceTypes();
  
  return c.json({ success: true, referenceTypes }, 200);
});

// ==========================================
// BULK ADD ENTITY TYPES
// ==========================================

const bulkAddEntityTypesRoute = createRoute({
  method: 'post',
  path: '/api/entity-types/bulk',
  summary: 'Bulk Add Entity Types',
  description: 'Add multiple entity types to the collection (append-only, requires moderator/admin)',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            tags: z.array(z.string().min(1).max(100)),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            entityTypes: z.array(z.string()),
          }),
        },
      },
      description: 'Entity types added successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Forbidden - Moderator or Admin access required',
    },
  },
});

selectionsRouter.openapi(bulkAddEntityTypesRoute, async (c) => {
  // Check moderation permissions
  const user = c.get('user');
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }
  
  const { tags } = c.req.valid('json');
  const graphDb = await getGraphDatabase();
  
  await graphDb.addEntityTypes(tags);
  const entityTypes = await graphDb.getEntityTypes();
  
  return c.json({ success: true, entityTypes }, 200);
});

// ==========================================
// BULK ADD REFERENCE TYPES
// ==========================================

const bulkAddReferenceTypesRoute = createRoute({
  method: 'post',
  path: '/api/reference-types/bulk',
  summary: 'Bulk Add Reference Types',
  description: 'Add multiple reference types to the collection (append-only, requires moderator/admin)',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            tags: z.array(z.string().min(1).max(100)),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.boolean(),
            referenceTypes: z.array(z.string()),
          }),
        },
      },
      description: 'Reference types added successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Forbidden - Moderator or Admin access required',
    },
  },
});

selectionsRouter.openapi(bulkAddReferenceTypesRoute, async (c) => {
  // Check moderation permissions
  const user = c.get('user');
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }
  
  const { tags } = c.req.valid('json');
  const graphDb = await getGraphDatabase();
  
  await graphDb.addReferenceTypes(tags);
  const referenceTypes = await graphDb.getReferenceTypes();
  
  return c.json({ success: true, referenceTypes }, 200);
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
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  };
}

function formatDocumentWithContent(doc: Document, content: string): any {
  return {
    ...formatDocument(doc),
    content,
  };
}

function formatSelection(sel: Selection): any {
  return {
    id: sel.id,
    documentId: sel.documentId,
    selectionType: sel.selectionType,
    selectionData: sel.selectionData,
    resolvedDocumentId: sel.resolvedDocumentId,
    resolvedAt: sel.resolvedAt instanceof Date ? sel.resolvedAt.toISOString() : sel.resolvedAt,
    resolvedBy: sel.resolvedBy,
    referenceTags: sel.referenceTags,
    entityTypes: sel.entityTypes,
    provisional: sel.provisional,
    confidence: sel.confidence,
    metadata: sel.metadata,
    createdBy: sel.createdBy,
    createdAt: sel.createdAt instanceof Date ? sel.createdAt.toISOString() : sel.createdAt,
    updatedAt: sel.updatedAt instanceof Date ? sel.updatedAt.toISOString() : sel.updatedAt,
  };
}

// Dummy content generation function
function generateDummyContent(
  selection: Selection,
  sourceDoc: Document,
  prompt?: string,
  requestedName?: string
): string {
  // Lorem ipsum word pool for random generation
  const loremWords = [
    'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
    'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
    'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
    'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
    'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
    'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
    'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
    'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum'
  ];

  // Generate random sentences
  const generateSentence = (minWords: number = 5, maxWords: number = 15): string => {
    const wordCount = Math.floor(Math.random() * (maxWords - minWords + 1)) + minWords;
    const words: string[] = [];
    
    for (let i = 0; i < wordCount; i++) {
      const randomIndex = Math.floor(Math.random() * loremWords.length);
      const randomWord = loremWords[randomIndex] || 'lorem';
      if (i === 0) {
        // Capitalize first word
        words.push(randomWord.charAt(0).toUpperCase() + randomWord.slice(1));
      } else {
        words.push(randomWord);
      }
    }
    
    return words.join(' ') + '.';
  };

  // Generate paragraphs
  const generateParagraph = (sentences: number = 4): string => {
    const paragraph: string[] = [];
    for (let i = 0; i < sentences; i++) {
      paragraph.push(generateSentence());
    }
    return paragraph.join(' ');
  };

  // Build the content
  const content: string[] = [];
  
  // Title/Header
  const title = requestedName || `Generated Document for "${(selection.selectionData as any).text || 'Selection'}"`;
  content.push(`# ${title}`);
  content.push('');
  
  // Metadata section
  content.push('## Document Information');
  content.push(`- Generated from: ${sourceDoc.name}`);
  content.push(`- Selection type: ${selection.selectionType}`);
  if (selection.entityTypes && selection.entityTypes.length > 0) {
    content.push(`- Entity types: ${selection.entityTypes.join(', ')}`);
  }
  if (prompt) {
    content.push(`- Generation prompt: "${prompt}"`);
  }
  content.push('');
  
  // Context section
  content.push('## Context');
  const selectionText = (selection.selectionData as any).text;
  if (selectionText) {
    content.push(`The selected text was: "${selectionText}"`);
    content.push('');
  }
  
  // Main content (Lorem ipsum)
  content.push('## Generated Content');
  content.push('');
  
  // Generate 3-5 paragraphs of Lorem ipsum
  const paragraphCount = Math.floor(Math.random() * 3) + 3;
  for (let i = 0; i < paragraphCount; i++) {
    const sentenceCount = Math.floor(Math.random() * 3) + 3; // 3-5 sentences per paragraph
    content.push(generateParagraph(sentenceCount));
    content.push('');
  }
  
  // Footer note
  content.push('---');
  content.push('*Note: This is dummy content generated for testing purposes. ' +
    'In production, this would be replaced with AI-generated content based on the selection context.*');
  
  return content.join('\n');
}