import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import type { UpdateDocumentInput } from '@semiont/core-types';
import { formatDocument, formatSelection } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { UpdateDocumentRequestSchema, GetDocumentResponseSchema } from '../schemas';
import { emitDocumentArchived, emitDocumentUnarchived, emitEntityTagAdded, emitEntityTagRemoved } from '../../../events/emit';

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
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const doc = await graphDb.getDocument(id);
    if (!doc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Only allow append-only operations
    // Document name and content are immutable after creation
    const updateInput: UpdateDocumentInput = {
      entityTypes: body.entityTypes,
      metadata: body.metadata,
      archived: body.archived,
    };

    const updatedDoc = await graphDb.updateDocument(id, updateInput);

    // Emit archived/unarchived events
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

    // Emit entity tag change events
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

    const content = await storage.getDocument(id);
    const highlights = await graphDb.getHighlights(id);
    const references = await graphDb.getReferences(id);
    const entityReferences = references.filter(ref => ref.entityTypes && ref.entityTypes.length > 0);

    return c.json({
      document: {
        ...formatDocument(updatedDoc),
        content: content.toString('utf-8')
      },
      selections: [...highlights, ...references].map(formatSelection),
      highlights: highlights.map(formatSelection),
      references: references.map(formatSelection),
      entityReferences: entityReferences.map(formatSelection),
    });
  });
}