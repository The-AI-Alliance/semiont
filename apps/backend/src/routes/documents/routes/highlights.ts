import { createRoute, z } from '@hono/zod-openapi';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { GetHighlightsResponseSchema } from '@semiont/core-types';

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
          schema: GetHighlightsResponseSchema,
        },
      },
      description: 'Document highlights',
    },
  },
});

export function registerDocumentHighlights(router: DocumentsRouterType) {
  router.openapi(getDocumentHighlightsRoute, async (c) => {
    const { id } = c.req.valid('param');

    // Layer 3 only - projection storage is source of truth
    const projectionHighlights = await AnnotationQueryService.getHighlights(id);

    // Transform projection format to component format
    const highlights = projectionHighlights.map(hl => ({
      id: hl.id,
      documentId: id,
      text: hl.text,
      selectionData: {
        type: 'text_span',
        offset: hl.position.offset,
        length: hl.position.length,
        text: hl.text
      },
      type: 'highlight' as const,
    }));

    return c.json({
      highlights
    });
  });
}