import { createRoute } from '@hono/zod-openapi';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import type { Document, CreateDocumentInput } from '@semiont/core-types';
import { CREATION_METHODS } from '@semiont/core-types';
import { calculateChecksum } from '@semiont/utils';
import { formatDocument, formatSelection } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { CreateDocumentRequestSchema, CreateDocumentResponseSchema } from '../schemas';

export const createDocumentRoute = createRoute({
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

export function registerCreateDocument(router: DocumentsRouterType) {
  router.openapi(createDocumentRoute, async (c) => {
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
      entityTypes: body.entityTypes || [],
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

    const highlights = await graphDb.getHighlights(savedDoc.id);
    const references = await graphDb.getReferences(savedDoc.id);

    return c.json({
      document: formatDocument(savedDoc),
      selections: [...highlights, ...references].map(formatSelection),
    }, 201);
  });
}