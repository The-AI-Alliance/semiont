import { createRoute, z } from '@hono/zod-openapi';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { GetReferencesResponseSchema } from '@semiont/core-types';

// GET /api/documents/{id}/references
export const getDocumentReferencesRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/references',
  summary: 'Get Document References',
  description: 'Get only references (selections with resolvedDocumentId) in a document',
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
          schema: GetReferencesResponseSchema,
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
    const projectionRefs = await AnnotationQueryService.getReferences(id);

    // Transform projection format to component format
    const references = projectionRefs.map(ref => ({
      id: ref.id,
      documentId: id,
      text: ref.text,
      selectionData: {
        type: 'text_span',
        offset: ref.position.offset,
        length: ref.position.length,
        text: ref.text
      },
      type: 'reference' as const,
      referencedDocumentId: ref.targetDocumentId,
      entityTypes: ref.entityTypes,
      referenceType: ref.referenceType,
    }));

    console.log(`[References] Returning ${references.length} references for ${id} from Layer 3`);

    return c.json({
      references
    });
  });
}