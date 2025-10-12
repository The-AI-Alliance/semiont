import { createRoute, z } from '@hono/zod-openapi';
import { getGraphDatabase } from '../../../graph/factory';
import {
  GetReferencedByResponseSchema as GetReferencedByResponseSchema,
  type GetReferencedByResponse,
  getExactText,
} from '@semiont/sdk';
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
          schema: GetReferencedByResponseSchema as any,
        },
      },
      description: 'Documents that reference this document',
    },
  },
});

export function registerGetReferencedBy(router: DocumentsRouterType) {
  router.openapi(getReferencedByRoute, async (c) => {
    const { id } = c.req.valid('param');
    const graphDb = await getGraphDatabase();

    // Get all annotations that reference this document
    const references = await graphDb.getDocumentReferencedBy(id);

    // Get unique documents from the selections
    const docIds = [...new Set(references.map(ref => ref.target.source))];
    const documents = await Promise.all(docIds.map(docId => graphDb.getDocument(docId)));

    // Build document map for lookup
    const docMap = new Map(documents.filter(doc => doc !== null).map(doc => [doc.id, doc]));

    // Transform into ReferencedBy structure
    const referencedBy = references.map(ref => {
      const doc = docMap.get(ref.target.source);
      return {
        id: ref.id,
        documentName: doc?.name || 'Untitled Document',
        target: {
          source: ref.target.source,
          selector: {
            exact: getExactText(ref.target.selector),
          },
        },
      };
    });

    const response: GetReferencedByResponse = {
      referencedBy,
    };

    return c.json(response);
  });
}