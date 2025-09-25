import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createDocumentRouter, type DocumentsRouterType } from './shared';
import { formatDocument, formatSelection } from './helpers';
import { CreateDocumentRequestSchema, CreateDocumentResponseSchema } from '@semiont/api-contracts';
import { getGraphDatabase } from '../../graph/factory';
import { getStorageService } from '../../storage/filesystem';
import type { Document, CreateDocumentInput } from '@semiont/core-types';
import { CREATION_METHODS, TOKEN_TYPES } from '@semiont/core-types';
import { calculateChecksum } from '@semiont/utils';

// Create router with auth middleware
export const contentRouter: DocumentsRouterType = createDocumentRouter();

// GET DOCUMENT CONTENT
const getDocumentContentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/content',
  summary: 'Get Document Content',
  description: 'Get raw content of a document',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'text/plain': {
          schema: z.string(),
        },
      },
      description: 'Document content',
    },
  },
});
contentRouter.openapi(getDocumentContentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const doc = await graphDb.getDocument(id);
  if (!doc) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  const content = await storage.getDocument(id);
  c.header('Content-Type', doc.contentType || 'text/plain');
  return c.body(content);
});

// CLONE DOCUMENT
const cloneDocumentRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/clone',
  summary: 'Clone Document',
  description: 'Create a copy of a document',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string(),
          }),
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
      description: 'Document cloned successfully',
    },
  },
});
contentRouter.openapi(cloneDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { name } = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const originalDoc = await graphDb.getDocument(id);
  if (!originalDoc) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  const content = await storage.getDocument(id);
  const checksum = calculateChecksum(content.toString('utf-8'));

  const clonedDoc: Document = {
    id: Math.random().toString(36).substring(2, 11),
    name,
    archived: false,
    contentType: originalDoc.contentType,
    metadata: { ...originalDoc.metadata, clonedFrom: id },
    entityTypes: originalDoc.entityTypes || [],
    creationMethod: CREATION_METHODS.CLONE,
    sourceDocumentId: id,
    contentChecksum: checksum,
    createdBy: user.id,
    createdAt: new Date(),
  };

  const createInput: CreateDocumentInput = {
    name: clonedDoc.name,
    entityTypes: clonedDoc.entityTypes,
    content: content.toString('utf-8'),
    contentType: clonedDoc.contentType,
    contentChecksum: clonedDoc.contentChecksum!,
    metadata: clonedDoc.metadata,
    createdBy: clonedDoc.createdBy!,
    creationMethod: clonedDoc.creationMethod,
    sourceDocumentId: clonedDoc.sourceDocumentId,
  };

  const savedDoc = await graphDb.createDocument(createInput);
  await storage.saveDocument(savedDoc.id, content);

  const highlights = await graphDb.getHighlights(savedDoc.id);
  const references = await graphDb.getReferences(savedDoc.id);

  return c.json({
    document: formatDocument(savedDoc),
    selections: [...highlights, ...references].map(formatSelection),
  }, 201);
});

// GET DOCUMENT BY TOKEN
const getDocumentByTokenRoute = createRoute({
  method: 'get',
  path: '/api/documents/by-token/{token}',
  summary: 'Get Document by Token',
  description: 'Get a document using a sharing token',
  tags: ['Documents'],
  request: {
    params: z.object({
      token: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            document: z.any(),
            content: z.string(),
            tokenType: z.enum(['public_read', 'public_edit']),
            expiresAt: z.string().nullable(),
          }),
        },
      },
      description: 'Document retrieved via token',
    },
  },
});
contentRouter.openapi(getDocumentByTokenRoute, async (c) => {
  const { token } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const tokenInfo = await graphDb.validateAccessToken(token);
  if (!tokenInfo) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  const document = await graphDb.getDocument(tokenInfo.documentId);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  const content = await storage.getDocument(document.id);

  return c.json({
    document: formatDocument(document),
    content: content.toString('utf-8'),
    tokenType: tokenInfo.tokenType,
    expiresAt: tokenInfo.expiresAt ? tokenInfo.expiresAt.toISOString() : null,
  });
});

// CREATE DOCUMENT FROM TOKEN
const createDocumentFromTokenRoute = createRoute({
  method: 'post',
  path: '/api/documents/from-token/{token}',
  summary: 'Create Document from Token',
  description: 'Create a new document using a sharing token',
  tags: ['Documents'],
  request: {
    params: z.object({
      token: z.string(),
    }),
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
      description: 'Document created via token',
    },
  },
});
contentRouter.openapi(createDocumentFromTokenRoute, async (c) => {
  const { token } = c.req.valid('param');
  const body = c.req.valid('json');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const tokenInfo = await graphDb.validateAccessToken(token);
  if (!tokenInfo || tokenInfo.tokenType !== TOKEN_TYPES.PUBLIC_EDIT) {
    throw new HTTPException(401, { message: 'Invalid token or insufficient permissions' });
  }

  const checksum = calculateChecksum(body.content);
  const document: Document = {
    id: Math.random().toString(36).substring(2, 11),
    name: body.name,
    archived: false,
    contentType: body.contentType || 'text/plain',
    metadata: { ...body.metadata, createdViaToken: token },
    entityTypes: body.entityTypes || [],
    creationMethod: CREATION_METHODS.TOKEN,
    sourceDocumentId: tokenInfo.documentId,
    contentChecksum: checksum,
    createdBy: 'anonymous',
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
    sourceDocumentId: document.sourceDocumentId,
  };

  const savedDoc = await graphDb.createDocument(createInput);
  await storage.saveDocument(savedDoc.id, Buffer.from(body.content));

  const highlights = await graphDb.getHighlights(savedDoc.id);
  const references = await graphDb.getReferences(savedDoc.id);

  return c.json({
    document: formatDocument(savedDoc),
    selections: [...highlights, ...references].map(formatSelection),
  }, 201);
});

// CREATE DOCUMENT FROM SELECTION
const createDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/documents/from-selection/{selectionId}',
  summary: 'Create Document from Selection',
  description: 'Create a new document from a selection/reference',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      selectionId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string(),
            content: z.string(),
            contentType: z.string().optional(),
            metadata: z.record(z.string(), z.any()).optional(),
          }),
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
      description: 'Document created from selection',
    },
  },
});
contentRouter.openapi(createDocumentFromSelectionRoute, async (c) => {
  const { selectionId } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const selection = await graphDb.getSelection(selectionId);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  const checksum = calculateChecksum(body.content);
  const document: Document = {
    id: Math.random().toString(36).substring(2, 11),
    name: body.name,
    archived: false,
    contentType: body.contentType || 'text/plain',
    metadata: { ...body.metadata, createdFromSelection: selectionId },
    entityTypes: selection.entityTypes || [],
    creationMethod: CREATION_METHODS.EXTRACTION,
    sourceSelectionId: selectionId,
    sourceDocumentId: selection.documentId,
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
    sourceSelectionId: document.sourceSelectionId,
    sourceDocumentId: document.sourceDocumentId,
  };

  const savedDoc = await graphDb.createDocument(createInput);
  await storage.saveDocument(savedDoc.id, Buffer.from(body.content));

  // Update the selection to resolve to the new document
  await graphDb.resolveSelection(selectionId, savedDoc.id, user.id);

  const highlights = await graphDb.getHighlights(savedDoc.id);
  const references = await graphDb.getReferences(savedDoc.id);

  return c.json({
    document: formatDocument(savedDoc),
    selections: [...highlights, ...references].map(formatSelection),
  }, 201);
});