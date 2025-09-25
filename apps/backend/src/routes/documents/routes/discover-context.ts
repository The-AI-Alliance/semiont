import { createRoute, z } from '@hono/zod-openapi';
import { getGraphDatabase } from '../../../graph/factory';
import { formatDocument } from '../helpers';
import type { DocumentsRouterType } from '../shared';

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
          schema: z.object({
            documents: z.array(z.any()),
            connections: z.array(z.object({
              fromId: z.string(),
              toId: z.string(),
              type: z.string(),
              metadata: z.any(),
            })),
          }),
        },
      },
      description: 'Context discovery results',
    },
  },
});

export function registerDiscoverContext(router: DocumentsRouterType) {
  router.openapi(discoverContextRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { depth } = c.req.valid('json');
    const graphDb = await getGraphDatabase();

    // Get document connections
    const connections = await graphDb.getDocumentConnections(id);
    const connectedDocs = connections.map(conn => conn.targetDocument);

    return c.json({
      documents: connectedDocs.map(formatDocument),
      connections: connections.map(conn => ({
        fromId: id,
        toId: conn.targetDocument.id,
        type: conn.relationshipType || 'reference',
        metadata: {},
      })),
    });
  });
}