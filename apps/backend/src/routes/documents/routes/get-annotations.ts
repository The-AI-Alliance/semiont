import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';

// Local schema
const GetAnnotationsResponse = z.object({
  annotations: z.array(z.any()),
});

// GET /api/documents/{id}/annotations
export const getDocumentAnnotationsRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/annotations',
  summary: 'Get Document Annotations',
  description: 'Get all annotations (both highlights and references) in a document',
  tags: ['Documents', 'Annotations'],
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
          schema: GetAnnotationsResponse,
        },
      },
      description: 'Document annotations',
    },
  },
});

export function registerGetDocumentAnnotations(router: DocumentsRouterType) {
  router.openapi(getDocumentAnnotationsRoute, async (c) => {
    const { id } = c.req.valid('param');

    try {
      // Try Layer 3 first (fast path - O(1) file read)
      const annotations = await AnnotationQueryService.getAllAnnotations(id);

      // Layer 3 projections have simplified format - return directly
      return c.json({
        annotations
      });
    } catch (error) {
      // Fallback to GraphDB if projection missing
      console.warn(`[Annotations] Layer 3 miss for ${id}, falling back to GraphDB`);

      const graphDb = await getGraphDatabase();
      const document = await graphDb.getDocument(id);
      if (!document) {
        throw new HTTPException(404, { message: 'Document not found' });
      }

      const highlights = await graphDb.getHighlights(id);
      const references = await graphDb.getReferences(id);

      return c.json({
        annotations: [...highlights, ...references]
      });
    }
  });
}