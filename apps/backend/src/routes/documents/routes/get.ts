import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getEventStore } from '../../../events/event-store';
import type { DocumentsRouterType } from '../shared';
import { GetDocumentResponseSchema } from '@semiont/core-types';
import { formatDocument } from '../helpers';

export const getDocumentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}',
  summary: 'Get Document',
  description: 'Get a document by ID',
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
          schema: GetDocumentResponseSchema,
        },
      },
      description: 'Document retrieved successfully',
    },
  },
});

export function registerGetDocument(router: DocumentsRouterType) {
  router.openapi(getDocumentRoute, async (c) => {
    const { id } = c.req.valid('param');

    // Read from Layer 2/3: Event store builds/loads projection
    const eventStore = await getEventStore();
    const stored = await eventStore.projectDocument(id);

    if (!stored) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // NOTE: Content is NOT included in this response
    // Clients must call GET /documents/:id/content separately to get content

    const annotations = [
      ...stored.annotations.highlights,
      ...stored.annotations.references
    ];
    const highlights = stored.annotations.highlights;
    const references = stored.annotations.references;
    const entityReferences = references.filter(ref => ref.body.entityTypes && ref.body.entityTypes.length > 0);

    return c.json({
      document: formatDocument(stored.document),
      annotations,
      highlights,
      references,
      entityReferences,
    });
  });
}