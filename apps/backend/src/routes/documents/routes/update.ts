import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getStorageService } from '../../../storage/filesystem';
import { formatDocument, formatAnnotation } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { UpdateDocumentRequestSchema, GetDocumentResponseSchema } from '@semiont/core-types';
import { emitDocumentArchived, emitDocumentUnarchived, emitEntityTagAdded, emitEntityTagRemoved } from '../../../events/emit';
import { DocumentQueryService } from '../../../services/document-queries';
import { AnnotationQueryService } from '../../../services/annotation-queries';

export const updateDocumentRoute = createRoute({
  method: 'patch',
  path: '/api/documents/{id}',
  summary: 'Update Document',
  description: 'Update document metadata (append-only operations - name and content are immutable)',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateDocumentRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GetDocumentResponseSchema,
        },
      },
      description: 'Document updated successfully',
    },
  },
});

export function registerUpdateDocument(router: DocumentsRouterType) {
  router.openapi(updateDocumentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const user = c.get('user');
    const storage = getStorageService();

    // Check document exists using Layer 3
    const doc = await DocumentQueryService.getDocumentMetadata(id);
    if (!doc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Emit archived/unarchived events (event store updates Layer 3, graph consumer updates Layer 4)
    if (body.archived !== undefined && body.archived !== doc.archived) {
      if (body.archived) {
        await emitDocumentArchived({
          documentId: id,
          userId: user.id,
        });
      } else {
        await emitDocumentUnarchived({
          documentId: id,
          userId: user.id,
        });
      }
    }

    // Emit entity tag change events (event store updates Layer 3, graph consumer updates Layer 4)
    if (body.entityTypes && doc.entityTypes) {
      const added = body.entityTypes.filter(et => !doc.entityTypes.includes(et));
      const removed = doc.entityTypes.filter(et => !body.entityTypes!.includes(et));

      for (const entityType of added) {
        await emitEntityTagAdded({ documentId: id, userId: user.id, entityType });
      }
      for (const entityType of removed) {
        await emitEntityTagRemoved({ documentId: id, userId: user.id, entityType });
      }
    }

    // Read content from Layer 1, annotations from Layer 3
    const content = await storage.getDocument(id);
    const highlights = await AnnotationQueryService.getHighlights(id);
    const references = await AnnotationQueryService.getReferences(id);

    // Return optimistic response
    return c.json({
      document: {
        ...formatDocument({
          ...doc,
          archived: body.archived !== undefined ? body.archived : doc.archived,
          entityTypes: body.entityTypes !== undefined ? body.entityTypes : doc.entityTypes,
        }),
        content: content.toString('utf-8')
      },
      annotations: [...highlights, ...references].map(formatAnnotation),
      highlights: highlights.map(formatAnnotation),
      references: references.map(formatAnnotation),
      entityReferences: references.filter(annotation => annotation.body.entityTypes.length > 0).map(formatAnnotation),
    });
  });
}