import { createRoute, z } from '@hono/zod-openapi';
import { formatDocument } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { ListDocumentsResponseSchema } from '@semiont/core-types';
import { DocumentQueryService } from '../../../services/document-queries';

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

    // Search using Layer 3 projection storage
    const matchingDocs = await DocumentQueryService.listDocuments({
      search: q,
    });

    // Limit results
    const limitedDocs = matchingDocs.slice(0, limit);

    return c.json({
      documents: limitedDocs.map(doc => formatDocument(doc)),
      total: limitedDocs.length,
      offset: 0,
      limit,
    });
  });
}