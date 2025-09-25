import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { formatDocument, formatSelection } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { GetDocumentResponseSchema } from '../schemas';

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
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();
    const document = await graphDb.getDocument(id);
    if (!document) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    const content = await storage.getDocument(id);
    const highlights = await graphDb.getHighlights(id);
    const references = await graphDb.getReferences(id);
    const entityReferences = references.filter(ref => ref.entityTypes && ref.entityTypes.length > 0);

    return c.json({
      document: {
        ...formatDocument(document),
        content: content.toString('utf-8')
      },
      selections: [...highlights, ...references].map(formatSelection),
      highlights: highlights.map(formatSelection),
      references: references.map(formatSelection),
      entityReferences: entityReferences.map(formatSelection),
    });
  });
}