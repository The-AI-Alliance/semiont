import { createRoute, z } from '@hono/zod-openapi';
import { getGraphDatabase } from '../../../graph/factory';
import type { DocumentsRouterType } from '../shared';
import { DiscoverContextResponseSchema, type DiscoverContextResponse } from '@semiont/core-types';

export const discoverContextRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/discover-context',
  summary: 'Discover Context',
  description: 'Discover related documents and concepts',
  tags: ['Documents', 'Graph'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            depth: z.number().min(1).max(3).default(2),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DiscoverContextResponseSchema,
        },
      },
      description: 'Context discovery results',
    },
  },
});

export function registerDiscoverContext(router: DocumentsRouterType) {
  router.openapi(discoverContextRoute, async (c) => {
    const { id } = c.req.valid('param');
    const graphDb = await getGraphDatabase();

    // Get document connections
    const connections = await graphDb.getDocumentConnections(id);
    const connectedDocs = connections.map(conn => conn.targetDocument);

    const response: DiscoverContextResponse = {
      documents: connectedDocs,
      connections: connections.map(conn => ({
        fromId: id,
        toId: conn.targetDocument.id,
        type: conn.relationshipType || 'link',
        metadata: {},
      })),
    };

    return c.json(response);
  });
}