import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { formatSelection } from '../../selections/helpers';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';

// Local schema
const GetHighlightsResponse = z.object({
  highlights: z.array(z.any()),
});

// GET /api/documents/{id}/highlights
export const getDocumentHighlightsRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/highlights',
  summary: 'Get Document Highlights',
  description: 'Get only highlights (selections without resolvedDocumentId) in a document',
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
          schema: GetHighlightsResponse,
        },
      },
      description: 'Document highlights',
    },
  },
});

export function registerDocumentHighlights(router: DocumentsRouterType) {
  router.openapi(getDocumentHighlightsRoute, async (c) => {
    const { id } = c.req.valid('param');

    try {
      // Try Layer 3 first (fast path - O(1) file read)
      const highlights = await AnnotationQueryService.getHighlights(id);

      // Layer 3 projections have simplified format - return directly
      return c.json({
        highlights
      });
    } catch (error) {
      // Fallback to GraphDB if projection missing
      console.warn(`[Highlights] Layer 3 miss for ${id}, falling back to GraphDB`);

      const graphDb = await getGraphDatabase();
      const document = await graphDb.getDocument(id);
      if (!document) {
        throw new HTTPException(404, { message: 'Document not found' });
      }

      const highlights = await graphDb.getHighlights(id);

      return c.json({
        highlights: highlights.map(formatSelection)
      });
    }
  });
}