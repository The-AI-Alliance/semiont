import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import type { DocumentsRouterType } from '../shared';

export const getDocumentContentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/content',
  summary: 'Get Document Content',
  description: 'Get raw content of a document',
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
        'text/plain': {
          schema: z.string(),
        },
      },
      description: 'Document content',
    },
  },
});

export function registerGetDocumentContent(router: DocumentsRouterType) {
  router.openapi(getDocumentContentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const doc = await graphDb.getDocument(id);
    if (!doc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    const content = await storage.getDocument(id);
    c.header('Content-Type', doc.contentType || 'text/plain');
    return c.text(content.toString('utf-8'));
  });
}