import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { calculateChecksum } from '@semiont/sdk';
import {
  CREATION_METHODS,
  GetDocumentByTokenResponseSchema as GetDocumentByTokenResponseSchema,
  CreateDocumentFromTokenRequestSchema as CreateDocumentFromTokenRequestSchema,
  CreateDocumentFromTokenResponseSchema as CreateDocumentFromTokenResponseSchema,
  CloneDocumentWithTokenResponseSchema as CloneDocumentWithTokenResponseSchema,
  type GetDocumentByTokenResponse,
  type CreateDocumentFromTokenResponse,
  type CloneDocumentWithTokenResponse,
  type Document,
  type CreateDocumentInput,
} from '@semiont/sdk';
import type { DocumentsRouterType } from '../shared';


// Simple in-memory token store (replace with Redis/DB in production)
const cloneTokens = new Map<string, { documentId: string; expiresAt: Date }>();

// GET /api/documents/token/{token}
export const getDocumentByTokenRoute = createRoute({
  method: 'get',
  path: '/api/documents/token/{token}',
  summary: 'Get Document by Clone Token',
  description: 'Retrieve a document using a clone token',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      token: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GetDocumentByTokenResponseSchema as any,
        },
      },
      description: 'Document retrieved successfully',
    },
  },
});

// POST /api/documents/create-from-token
export const createDocumentFromTokenRoute = createRoute({
  method: 'post',
  path: '/api/documents/create-from-token',
  summary: 'Create Document from Clone Token',
  description: 'Create a new document using a clone token',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateDocumentFromTokenRequestSchema as any,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateDocumentFromTokenResponseSchema as any,
        },
      },
      description: 'Document created successfully',
    },
  },
});

// Updated clone route that generates a token
export const cloneDocumentWithTokenRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/clone-with-token',
  summary: 'Clone Document with Token',
  description: 'Generate a temporary token for cloning a document',
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
        'application/json': {
          schema: CloneDocumentWithTokenResponseSchema as any,
        },
      },
      description: 'Clone token generated successfully',
    },
  },
});

export function registerTokenRoutes(router: DocumentsRouterType) {
  // Get document by token
  router.openapi(getDocumentByTokenRoute, async (c) => {
    const { token } = c.req.valid('param');

    const tokenData = cloneTokens.get(token);
    if (!tokenData) {
      throw new HTTPException(404, { message: 'Invalid or expired token' });
    }

    if (new Date() > tokenData.expiresAt) {
      cloneTokens.delete(token);
      throw new HTTPException(404, { message: 'Token expired' });
    }

    const graphDb = await getGraphDatabase();
    const sourceDoc = await graphDb.getDocument(tokenData.documentId);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source document not found' });
    }

    // NOTE: Content is NOT included - frontend should fetch via GET /documents/:id/content

    const response: GetDocumentByTokenResponse = {
      sourceDocument: sourceDoc,
      expiresAt: tokenData.expiresAt.toISOString(),
    };

    return c.json(response);
  });

  // Create document from token
  router.openapi(createDocumentFromTokenRoute, async (c) => {
    const body = c.req.valid('json');
    const user = c.get('user');

    const tokenData = cloneTokens.get(body.token);
    if (!tokenData) {
      throw new HTTPException(404, { message: 'Invalid or expired token' });
    }

    if (new Date() > tokenData.expiresAt) {
      cloneTokens.delete(body.token);
      throw new HTTPException(404, { message: 'Token expired' });
    }

    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    // Get source document
    const sourceDoc = await graphDb.getDocument(tokenData.documentId);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source document not found' });
    }

    // Create new document
    const checksum = calculateChecksum(body.content);
    const document: Document = {
      id: Math.random().toString(36).substring(2, 11),
      name: body.name,
      archived: false,
      format: sourceDoc.format,
      entityTypes: sourceDoc.entityTypes || [],

      // Clone context
      creationMethod: CREATION_METHODS.CLONE,
      sourceDocumentId: tokenData.documentId,
      contentChecksum: checksum,

      creator: user.id,
      created: new Date().toISOString(),
    };

    const documentId = `doc-sha256:${checksum}`;

    const createInput: CreateDocumentInput & { id: string } = {
      id: documentId,
      name: document.name,
      entityTypes: document.entityTypes,
      content: body.content,
      format: document.format,
      contentChecksum: document.contentChecksum!,
      creator: document.creator!,
      creationMethod: document.creationMethod,
      sourceDocumentId: document.sourceDocumentId,
    };

    const savedDoc = await graphDb.createDocument(createInput);
    await storage.saveDocument(documentId, Buffer.from(body.content));

    // Archive original if requested
    if (body.archiveOriginal) {
      await graphDb.updateDocument(tokenData.documentId, {
        archived: true
      });
    }

    // Clean up token
    cloneTokens.delete(body.token);

    // Get annotations
    const highlights = await graphDb.getHighlights(savedDoc.id);
    const references = await graphDb.getReferences(savedDoc.id);

    const response: CreateDocumentFromTokenResponse = {
      document: savedDoc,
      annotations: [...highlights, ...references],
    };

    return c.json(response, 201);
  });

  // Generate clone token
  router.openapi(cloneDocumentWithTokenRoute, async (c) => {
    const { id } = c.req.valid('param');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const sourceDoc = await graphDb.getDocument(id);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Check if content exists
    try {
      await storage.getDocument(id);
    } catch {
      throw new HTTPException(404, { message: 'Document content not found' });
    }

    // Create token
    const token = `clone_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    cloneTokens.set(token, {
      documentId: id,
      expiresAt,
    });

    const response: CloneDocumentWithTokenResponse = {
      token,
      expiresAt: expiresAt.toISOString(),
      document: sourceDoc,
    };

    return c.json(response);
  });
}