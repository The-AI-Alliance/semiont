import { createRoute, z } from '@hono/zod-openapi';
import { getGraphDatabase } from '../../../graph/factory';
import { formatDocument } from '../helpers';
import type { Document } from '@semiont/core-types';
import type { DocumentsRouterType } from '../shared';
import { ListDocumentsResponseSchema } from '../schemas';

export const searchDocumentsRoute = createRoute({
  method: 'get',
  path: '/api/documents/search',
  summary: 'Search Documents',
  description: 'Search documents by name',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z.string().min(1),
      limit: z.coerce.number().default(10),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListDocumentsResponseSchema,
        },
      },
      description: 'Search results',
    },
  },
});

export function registerSearchDocuments(router: DocumentsRouterType) {
  router.openapi(searchDocumentsRoute, async (c) => {
    const { q, limit } = c.req.valid('query');
    const graphDb = await getGraphDatabase();

    const allDocs = await graphDb.listDocuments({});
    const query = q.toLowerCase();
    const matchingDocs = allDocs.documents
      .filter((doc: Document) => doc.name.toLowerCase().includes(query))
      .slice(0, limit);

    return c.json({
      documents: matchingDocs.map(formatDocument),
      total: matchingDocs.length,
      offset: 0,
      limit,
    });
  });
}