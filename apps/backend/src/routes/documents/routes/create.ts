import { createRoute } from '@hono/zod-openapi';
import { getStorageService } from '../../../storage/filesystem';
import { CREATION_METHODS } from '@semiont/core-types';
import { calculateChecksum } from '@semiont/utils';
import type { DocumentsRouterType } from '../shared';
import { CreateDocumentRequestSchema, CreateDocumentResponseSchema } from '../schemas';
import { emitDocumentCreated } from '../../../events/emit';

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
    const storage = getStorageService();

    const checksum = calculateChecksum(body.content);
    const documentId = `doc-sha256:${checksum}`;

    // Save to filesystem (Layer 1)
    await storage.saveDocument(documentId, Buffer.from(body.content));

    // Subscribe GraphDB consumer to new document BEFORE emitting event
    // This ensures the consumer receives the document.created event
    try {
      const { getGraphConsumer } = await import('../../../events/consumers/graph-consumer');
      const consumer = await getGraphConsumer();
      await consumer.subscribeToDocument(documentId);
    } catch (error) {
      console.error('[CreateDocument] Failed to subscribe GraphDB consumer:', error);
      // Don't fail the request - consumer can catch up later
    }

    // Emit document.created event (consumer will update GraphDB)
    const eventMetadata = {
      ...(body.metadata || {}),
      creationMethod: CREATION_METHODS.API,
    };
    console.log('[CreateDocument] Event metadata:', eventMetadata);

    await emitDocumentCreated({
      documentId,
      userId: user.id,
      name: body.name,
      contentType: body.contentType || 'text/plain',
      contentHash: checksum,
      entityTypes: body.entityTypes || [],
      metadata: eventMetadata,
    });

    // Return optimistic response
    return c.json({
      document: {
        id: documentId,
        name: body.name,
        archived: false,
        contentType: body.contentType || 'text/plain',
        metadata: body.metadata || {},
        entityTypes: body.entityTypes || [],
        creationMethod: CREATION_METHODS.API,
        contentChecksum: checksum,
        createdBy: user.id,
        createdAt: new Date().toISOString(),
      },
      selections: [],
    }, 201);
  });
}