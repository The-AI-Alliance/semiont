import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { formatSelection } from '../../selections/helpers';
import type { DocumentsRouterType } from '../shared';

// Local schema
const GetSelectionsResponse = z.object({
  selections: z.array(z.any()),
});

// GET /api/documents/{id}/selections
export const getDocumentSelectionsRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/selections',
  summary: 'Get Document Selections',
  description: 'Get all selections (both highlights and references) in a document',
  tags: ['Documents', 'Selections'],
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
          schema: GetSelectionsResponse,
        },
      },
      description: 'Document selections',
    },
  },
});

export function registerGetDocumentSelections(router: DocumentsRouterType) {
  router.openapi(getDocumentSelectionsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const graphDb = await getGraphDatabase();

    const document = await graphDb.getDocument(id);
    if (!document) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    const highlights = await graphDb.getHighlights(id);
    const references = await graphDb.getReferences(id);

    return c.json({
      selections: [...highlights, ...references].map(formatSelection)
    });
  });
}