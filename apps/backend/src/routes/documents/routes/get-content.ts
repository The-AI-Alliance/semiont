import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
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
    const storage = getStorageService();

    // Read directly from Layer 1 (filesystem) - no graph needed
    const content = await storage.getDocument(id);
    if (!content) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Content type is text/plain by default (can be enhanced with metadata from Layer 3 projection later)
    c.header('Content-Type', 'text/plain');
    return c.text(content.toString('utf-8'));
  });
}