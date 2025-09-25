import { createRoute, z } from '@hono/zod-openapi';
import { getGraphDatabase } from '../../../graph/factory';
import { formatDocument, formatSelection } from '../helpers';
import type { DocumentsRouterType } from '../shared';

export const getReferencedByRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/referenced-by',
  summary: 'Get Referenced By',
  description: 'Get documents that reference this document',
  tags: ['Documents', 'Graph'],
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
          schema: z.object({
            documents: z.array(z.any()),
            references: z.array(z.any()),
          }),
        },
      },
      description: 'Referencing documents',
    },
  },
});

export function registerGetReferencedBy(router: DocumentsRouterType) {
  router.openapi(getReferencedByRoute, async (c) => {
    const { id } = c.req.valid('param');
    const graphDb = await getGraphDatabase();

    // Find all selections that resolve to this document
    const referencingDocs = await graphDb.getDocumentsReferencingDocument(id);

    // Get the actual references/selections
    const references = await graphDb.getReferencesToDocument(id);

    return c.json({
      documents: referencingDocs.map(formatDocument),
      references: references.map(formatSelection),
    });
  });
}