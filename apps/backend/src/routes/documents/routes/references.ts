import { createRoute, z } from '@hono/zod-openapi';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import {
  GetReferencesResponseSchema as GetReferencesResponseSchema,
  type GetReferencesResponse,
} from '@semiont/core';


// GET /api/documents/{id}/references
export const getDocumentReferencesRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/references',
  summary: 'Get Document References',
  description: 'Get only references (annotations with body of type SpecifiedResource with a source) in a document',
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
          schema: GetReferencesResponseSchema as any,
        },
      },
      description: 'Document references',
    },
  },
});

export function registerDocumentReferences(router: DocumentsRouterType) {
  router.openapi(getDocumentReferencesRoute, async (c) => {
    const { id } = c.req.valid('param');

    // Layer 3 only - projection storage is source of truth
    // Projections now store full Annotation objects - no transformation needed
    const references = await AnnotationQueryService.getReferences(id);

    console.log(`[References] Returning ${references.length} references for ${id} from Layer 3`);

    const response: GetReferencesResponse = {
      references
    };

    return c.json(response);
  });
}