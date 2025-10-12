import { createRoute, z } from '@hono/zod-openapi';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import {
  GetHighlightsResponseSchemaOpenAPI as GetHighlightsResponseSchema,
  type GetHighlightsResponse,
} from '@semiont/sdk';

// GET /api/documents/{id}/highlights
export const getDocumentHighlightsRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/highlights',
  summary: 'Get Document Highlights',
  description: 'Get only highlights (annotations without body of type SpecifiedResource with a source) in a document',
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
    // Projections now store full Annotation objects - no transformation needed
    const highlights = await AnnotationQueryService.getHighlights(id);

    const response: GetHighlightsResponse = {
      highlights
    };

    return c.json(response);
  });
}