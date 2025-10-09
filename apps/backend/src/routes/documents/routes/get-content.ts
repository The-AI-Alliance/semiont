import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getStorageService } from '../../../storage/filesystem';
import { DocumentQueryService } from '../../../services/document-queries';
import type { DocumentsRouterType } from '../shared';

export const getDocumentContentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/content',
  summary: 'Get Document Content',
  description: 'Get raw content of a document with correct MIME type from document metadata',
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
        'text/markdown': {
          schema: z.string(),
        },
        'application/pdf': {
          schema: z.string(),
        },
      },
      description: 'Document content with MIME type from document.format',
    },
  },
});

export function registerGetDocumentContent(router: DocumentsRouterType) {
  router.openapi(getDocumentContentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const storage = getStorageService();

    // Get document metadata from Layer 3 to retrieve the format (MIME type)
    const doc = await DocumentQueryService.getDocumentMetadata(id);
    if (!doc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Read content from Layer 1 (filesystem)
    const content = await storage.getDocument(id);
    if (!content) {
      throw new HTTPException(404, { message: 'Document content not found' });
    }

    // Set Content-Type header from document.format (W3C alignment)
    c.header('Content-Type', doc.format);
    return c.text(content.toString('utf-8'));
  });
}