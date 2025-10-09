import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { detectAnnotationsInDocument } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { DetectAnnotationsResponseSchema, type DetectAnnotationsResponse } from '@semiont/core-types';

// Local schemas to avoid TypeScript hanging
const DetectAnnotationsRequest = z.object({
  entityTypes: z.array(z.string()).optional(),
});

export const detectAnnotationsRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/detect-annotations',
  summary: 'Detect Annotations',
  description: 'Use AI to detect entity references in document',
  tags: ['Documents', 'AI'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: DetectAnnotationsRequest,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DetectAnnotationsResponseSchema,
        },
      },
      description: 'Detected annotations',
    },
  },
});

export function registerDetectAnnotations(router: DocumentsRouterType) {
  router.openapi(detectAnnotationsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const user = c.get('user');
    const graphDb = await getGraphDatabase();

    const document = await graphDb.getDocument(id);
    if (!document) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Detect annotations using AI (loads content from filesystem internally)
    const detectedAnnotations = await detectAnnotationsInDocument(id, document.format, body.entityTypes || []);

    // Save the stub references
    const savedSelections = [];
    for (const detected of detectedAnnotations) {
      const selectionInput = {
        target: {
          source: id,
          selector: {
            type: 'TextPositionSelector' as const,
            exact: detected.annotation.selector.exact,
            offset: detected.annotation.selector.offset,
            length: detected.annotation.selector.length,
          },
        },
        body: {
          type: 'SpecificResource' as const,
          entityTypes: detected.annotation.entityTypes || [],
          source: null,  // null = stub reference
        },
        creator: user.id
      };
      const saved = await graphDb.createAnnotation(selectionInput);
      savedSelections.push(saved);
    }

    console.log('Returning', savedSelections.length, 'saved annotations');

    const response: DetectAnnotationsResponse = {
      annotations: savedSelections.map(s => ({
        id: s.id,
        documentId: s.target.source,
        selector: s.target.selector,
        source: s.body.source ?? null,
        entityTypes: s.body.entityTypes,
        created: s.created, // ISO string from createAnnotation
      })),
      detected: savedSelections.length,
    };

    return c.json(response);
  });
}