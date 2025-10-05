import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { detectSelectionsInDocument } from '../helpers';
import type { CreateSelectionInput } from '@semiont/core-types';
import type { DocumentsRouterType } from '../shared';

// Local schemas to avoid TypeScript hanging
const DetectSelectionsRequest = z.object({
  entityTypes: z.array(z.string()).optional(),
});

const DetectSelectionsResponse = z.object({
  selections: z.array(z.object({
    id: z.string(),
    documentId: z.string(),
    selectionData: z.any(),
    resolvedDocumentId: z.string().nullable().optional(),
    entityTypes: z.array(z.string()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
  detected: z.number().int().min(0),
});

export const detectSelectionsRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/detect-selections',
  summary: 'Detect Selections',
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
          schema: DetectSelectionsRequest,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DetectSelectionsResponse,
        },
      },
      description: 'Detected selections',
    },
  },
});

export function registerDetectSelections(router: DocumentsRouterType) {
  router.openapi(detectSelectionsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const user = c.get('user');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const document = await graphDb.getDocument(id);
    if (!document) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    const content = await storage.getDocument(id);
    const docWithContent = { ...document, content: content.toString('utf-8') };

    // Detect selections using AI
    const detectedSelections = await detectSelectionsInDocument(docWithContent, body.entityTypes || []);

    // Save the stub references
    const savedSelections = [];
    for (const detected of detectedSelections) {
      const selectionInput: CreateSelectionInput & { selectionType: string } = {
        documentId: id,
        selectionType: 'reference',  // Graph implementations need this for stub references
        selectionData: detected.selection.selectionData,
        resolvedDocumentId: null,  // null = stub reference
        entityTypes: detected.selection.entityTypes,
        metadata: detected.selection.metadata,
        createdBy: user.id,
      };
      const saved = await graphDb.createSelection(selectionInput);
      savedSelections.push(saved);
    }

    console.log('Returning', savedSelections.length, 'saved selections');
    return c.json({
      selections: savedSelections.map(s => ({
        id: s.id,
        documentId: s.documentId,
        selectionData: s.selectionData,
        resolvedDocumentId: s.resolvedDocumentId,
        entityTypes: s.entityTypes,
        createdAt: s.createdAt?.toISOString() || new Date().toISOString(),
        updatedAt: s.updatedAt?.toISOString() || new Date().toISOString(),
      })),
      detected: savedSelections.length,
    });
  });
}