import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createDocumentRouter, type DocumentsRouterType } from './shared';
import { formatDocument, formatSelection } from './helpers';
import {
  CreateDocumentRequestSchema,
  CreateDocumentResponseSchema,
  GetDocumentResponseSchema,
  ListDocumentsResponseSchema,
  UpdateDocumentRequestSchema,
} from '@semiont/api-contracts';
import { getGraphDatabase } from '../../graph/factory';
import { getStorageService } from '../../storage/filesystem';
import type { Document, Selection, UpdateDocumentInput, CreateDocumentInput } from '@semiont/core-types';
import { CREATION_METHODS } from '@semiont/core-types';
import { calculateChecksum } from '@semiont/utils';

// Create router with auth middleware
export const crudRouter: DocumentsRouterType = createDocumentRouter();

// CREATE
const createDocumentRoute = createRoute({
  method: 'post',
  path: '/api/documents',
  summary: 'Create Document',
  description: 'Create a new document',
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
  },
});
crudRouter.openapi(createDocumentRoute, async (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const checksum = calculateChecksum(body.content);
  const document: Document = {
    id: Math.random().toString(36).substring(2, 11),
    name: body.name,
    archived: false,
    contentType: body.contentType || 'text/plain',
    metadata: body.metadata || {},
    entityTypes: [],

    // Creation context
    creationMethod: CREATION_METHODS.API,
    sourceSelectionId: body.sourceSelectionId,
    sourceDocumentId: body.sourceDocumentId,
    contentChecksum: checksum,

    createdBy: user.id,
    createdAt: new Date(),
  };

  const createInput: CreateDocumentInput = {
    name: document.name,
    entityTypes: document.entityTypes,
    content: body.content,
    contentType: document.contentType,
    contentChecksum: document.contentChecksum!,
    metadata: document.metadata,
    createdBy: document.createdBy!,
    creationMethod: document.creationMethod,
    ...(document.sourceSelectionId ? { sourceSelectionId: document.sourceSelectionId } : {}),
    ...(document.sourceDocumentId ? { sourceDocumentId: document.sourceDocumentId } : {}),
  };

  const savedDoc = await graphDb.createDocument(createInput);
  await storage.saveDocument(savedDoc.id, Buffer.from(body.content));

  // Get selections
  const highlights = await graphDb.getHighlights(savedDoc.id);
  const references = await graphDb.getReferences(savedDoc.id);

  return c.json({
    document: formatDocument(savedDoc),
    selections: [...highlights, ...references].map(formatSelection),
  }, 201);
});

// GET
const getDocumentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}',
  summary: 'Get Document',
  description: 'Get a document by ID',
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
  },
});
crudRouter.openapi(getDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  // Get content from storage
  const content = await storage.getDocument(id);

  // Get selections
  const highlights = await graphDb.getHighlights(id);
  const references = await graphDb.getReferences(id);
  const entityReferences = references.filter(ref => ref.entityTypes && ref.entityTypes.length > 0);

  return c.json({
    document: {
      ...formatDocument(document),
      content: content.toString('utf-8')
    },
    selections: [...highlights, ...references].map(formatSelection),
    highlights: highlights.map(formatSelection),
    references: references.map(formatSelection),
    entityReferences: entityReferences.map(formatSelection),
  });
});

// LIST
const listDocumentsRoute = createRoute({
  method: 'get',
  path: '/api/documents',
  summary: 'List Documents',
  description: 'List all documents with optional filters',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      offset: z.coerce.number().default(0),
      limit: z.coerce.number().default(50),
      entityType: z.string().optional(),
      archived: z.union([
        z.literal('true').transform(() => true),
        z.literal('false').transform(() => false),
        z.boolean()
      ]).optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListDocumentsResponseSchema,
        },
      },
      description: 'Documents listed successfully',
    },
  },
});
crudRouter.openapi(listDocumentsRoute, async (c) => {
  const { offset, limit, entityType, archived, search } = c.req.valid('query');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const allDocs = await graphDb.listDocuments({});

  // Apply filters
  let filteredDocs = allDocs.documents;

  // Apply search filter if provided
  if (search) {
    const searchLower = search.toLowerCase();
    filteredDocs = filteredDocs.filter(doc =>
      doc.name.toLowerCase().includes(searchLower)
    );
  }

  if (entityType) {
    filteredDocs = filteredDocs.filter(doc => doc.entityTypes?.includes(entityType));
  }
  if (archived !== undefined) {
    filteredDocs = filteredDocs.filter(doc => doc.archived === archived);
  }

  // Paginate
  const paginatedDocs = filteredDocs.slice(offset, offset + limit);

  // For search results, load content snippets
  let documentsWithContent = paginatedDocs;
  if (search) {
    documentsWithContent = await Promise.all(
      paginatedDocs.map(async (doc) => {
        try {
          const contentBuffer = await storage.getDocument(doc.id);
          const contentStr = contentBuffer.toString('utf-8');
          return { ...doc, content: contentStr.slice(0, 200) };
        } catch {
          return { ...doc, content: '' };
        }
      })
    );
  }

  return c.json({
    documents: documentsWithContent.map(formatDocument),
    total: filteredDocs.length,
    offset,
    limit,
  });
});

// UPDATE
const updateDocumentRoute = createRoute({
  method: 'patch',
  path: '/api/documents/{id}',
  summary: 'Update Document',
  description: 'Update a document',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
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
          schema: GetDocumentResponseSchema,
        },
      },
      description: 'Document updated successfully',
    },
  },
});
crudRouter.openapi(updateDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const doc = await graphDb.getDocument(id);
  if (!doc) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  const updateInput: UpdateDocumentInput = {
    id,
    name: body.name,
    entityTypes: body.entityTypes,
    metadata: body.metadata,
    archived: body.archived,
  };

  const updatedDoc = await graphDb.updateDocument(updateInput);

  // If content is provided, update it
  if (body.content) {
    await storage.saveDocument(id, Buffer.from(body.content));
  }

  const content = await storage.getDocument(id);
  const highlights = await graphDb.getHighlights(id);
  const references = await graphDb.getReferences(id);
  const entityReferences = references.filter(ref => ref.entityTypes && ref.entityTypes.length > 0);

  return c.json({
    document: {
      ...formatDocument(updatedDoc),
      content: content.toString('utf-8')
    },
    selections: [...highlights, ...references].map(formatSelection),
    highlights: highlights.map(formatSelection),
    references: references.map(formatSelection),
    entityReferences: entityReferences.map(formatSelection),
  });
});

// DELETE
const deleteDocumentRoute = createRoute({
  method: 'delete',
  path: '/api/documents/{id}',
  summary: 'Delete Document',
  description: 'Delete a document',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    204: {
      description: 'Document deleted successfully',
    },
  },
});
crudRouter.openapi(deleteDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const doc = await graphDb.getDocument(id);
  if (!doc) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  await graphDb.deleteDocument(id);
  await storage.deleteDocument(id);

  return c.body(null, 204);
});