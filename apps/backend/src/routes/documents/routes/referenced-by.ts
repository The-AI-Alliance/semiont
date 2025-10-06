import { createRoute, z } from '@hono/zod-openapi';
import { getGraphDatabase } from '../../../graph/factory';
import { formatDocument, formatAnnotation } from '../helpers';
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

    // Get all selections that reference this document
    const references = await graphDb.getDocumentReferencedBy(id);

    // Get unique documents from the selections
    const docIds = [...new Set(references.map(ref => ref.documentId))];
    const documents = await Promise.all(docIds.map(docId => graphDb.getDocument(docId)));
    const referencingDocs = documents.filter(doc => doc !== null);

    return c.json({
      documents: referencingDocs.map(formatDocument),
      references: references.map(formatAnnotation),
    });
  });
}