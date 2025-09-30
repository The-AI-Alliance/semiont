import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { formatSelection } from '../../selections/helpers';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';

// Local schema
const GetReferencesResponse = z.object({
  references: z.array(z.any()),
});

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
          schema: GetReferencesResponse,
        },
      },
      description: 'Document references',
    },
  },
});

export function registerDocumentReferences(router: DocumentsRouterType) {
  router.openapi(getDocumentReferencesRoute, async (c) => {
    const { id } = c.req.valid('param');

    try {
      // Try Layer 3 first (fast path - O(1) file read)
      const references = await AnnotationQueryService.getReferences(id);

      // Layer 3 projections have simplified format - return directly
      return c.json({
        references
      });
    } catch (error) {
      // Fallback to GraphDB if projection missing
      console.warn(`[References] Layer 3 miss for ${id}, falling back to GraphDB`);

      const graphDb = await getGraphDatabase();
      const document = await graphDb.getDocument(id);
      if (!document) {
        throw new HTTPException(404, { message: 'Document not found' });
      }

      const references = await graphDb.getReferences(id);

      return c.json({
        references: references.map(formatSelection)
      });
    }
  });
}