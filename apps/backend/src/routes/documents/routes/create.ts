import { createRoute } from '@hono/zod-openapi';
import { getStorageService } from '../../../storage/filesystem';
import {
  CREATION_METHODS,
  type CreationMethod,
  CreateDocumentRequestSchema as CreateDocumentRequestSchema,
  CreateDocumentResponseSchema as CreateDocumentResponseSchema,
  type Document,
  type CreateDocumentResponse,
  calculateChecksum,
} from '@semiont/sdk';
import type { DocumentsRouterType } from '../shared';
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
          schema: CreateDocumentRequestSchema as any,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateDocumentResponseSchema as any,
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

    // Validate and use creationMethod from request body, or default to API
    const validCreationMethods = Object.values(CREATION_METHODS) as string[];
    const creationMethod: CreationMethod = body.creationMethod && validCreationMethods.includes(body.creationMethod)
      ? body.creationMethod as CreationMethod
      : CREATION_METHODS.API;

    // Emit document.created event (consumer will update GraphDB)
    await emitDocumentCreated({
      documentId,
      userId: user.id,
      name: body.name,
      format: body.format,
      contentHash: checksum,
      creationMethod,
      entityTypes: body.entityTypes,
    });

    // Return optimistic response
    const documentMetadata: Document = {
      id: documentId,
      name: body.name,
      archived: false,
      format: body.format,
      entityTypes: body.entityTypes,
      creationMethod,
      contentChecksum: checksum,
      creator: user.id,
      created: new Date().toISOString(),
    };

    const response: CreateDocumentResponse = {
      document: documentMetadata,
      annotations: [],
    };

    return c.json(response, 201);
  });
}