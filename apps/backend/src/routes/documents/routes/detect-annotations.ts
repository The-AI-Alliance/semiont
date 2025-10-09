import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { detectAnnotationsInDocument } from '../helpers';
import type { DocumentsRouterType } from '../shared';

// Local schemas to avoid TypeScript hanging
const DetectAnnotationsRequest = z.object({
  entityTypes: z.array(z.string()).optional(),
});

const DetectAnnotationsResponse = z.object({
  annotations: z.array(z.object({
    id: z.string(),
    documentId: z.string(),
    selector: z.any(),
    source: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).optional(),
    created: z.string(),
  })),
  detected: z.number().int().min(0),
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
          schema: DetectAnnotationsResponse,
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
    const detectedAnnotations = await detectAnnotationsInDocument(id, document.contentType, body.entityTypes || []);

    // Save the stub references
    const savedSelections = [];
    for (const detected of detectedAnnotations) {
      const selectionInput = {
        target: {
          source: id,
          selector: {
            type: 'TextPositionSelector' as const,
            exact: detected.selection.selector.exact,
            offset: detected.selection.selector.offset,
            length: detected.selection.selector.length,
          },
        },
        body: {
          type: 'SpecificResource' as const,
          entityTypes: detected.selection.entityTypes || [],
          source: null,  // null = stub reference
        },
        creator: user.id
      };
      const saved = await graphDb.createAnnotation(selectionInput);
      savedSelections.push(saved);
    }

    console.log('Returning', savedSelections.length, 'saved annotations');
    return c.json({
      annotations: savedSelections.map(s => ({
        id: s.id,
        documentId: s.target.source,
        selector: s.target.selector,
        source: s.body.source,
        entityTypes: s.body.entityTypes,
        created: s.created, // ISO string from createAnnotation
      })),
      detected: savedSelections.length,
    });
  });
}