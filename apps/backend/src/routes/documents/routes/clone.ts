import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { CREATION_METHODS } from '@semiont/core-types';
import { calculateChecksum } from '@semiont/utils';
import { formatSelection } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { emitDocumentCloned, emitHighlightAdded, emitReferenceCreated } from '../../../events/emit';

// Local schema to avoid TypeScript hanging
const CloneDocumentResponse = z.object({
  document: z.any(),
  selections: z.array(z.any()),
});

export const cloneDocumentRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/clone',
  summary: 'Clone Document',
  description: 'Create a copy of a document',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CloneDocumentResponse,
        },
      },
      description: 'Document cloned successfully',
    },
  },
});

export function registerCloneDocument(router: DocumentsRouterType) {
  router.openapi(cloneDocumentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const user = c.get('user');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const sourceDoc = await graphDb.getDocument(id);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source document not found' });
    }

    const content = await storage.getDocument(id);
    const contentStr = content.toString('utf-8');
    const checksum = calculateChecksum(contentStr);
    const newDocId = `doc-sha256:${checksum}`;

    // Save to filesystem (Layer 1)
    await storage.saveDocument(newDocId, content);

    // Emit document.cloned event (consumer will create in GraphDB)
    await emitDocumentCloned({
      documentId: newDocId,
      userId: user.id,
      name: body.name,
      contentType: sourceDoc.contentType,
      contentHash: checksum,
      parentDocumentId: id,
      entityTypes: sourceDoc.entityTypes,
      metadata: { ...sourceDoc.metadata, clonedFrom: id },
    });

    // Propagate annotations from source document
    // Since content is identical, all text positions remain valid
    const sourceHighlights = await graphDb.getHighlights(id);
    const sourceReferences = await graphDb.getReferences(id);

    const clonedSelections: any[] = [];

    // Copy highlights to new document (emit events - consumer will create in GraphDB)
    for (const highlight of sourceHighlights) {
      const highlightId = graphDb.generateId();
      await emitHighlightAdded({
        documentId: newDocId,
        userId: user.id,
        highlightId,
        text: highlight.selectionData.text,
        position: {
          offset: highlight.selectionData.offset,
          length: highlight.selectionData.length,
        },
      });
      clonedSelections.push({
        id: highlightId,
        documentId: newDocId,
        selectionType: 'highlight',
        selectionData: highlight.selectionData,
        entityTypes: highlight.entityTypes,
        createdBy: user.id,
        createdAt: new Date().toISOString(),
      });
    }

    // Copy references to new document (emit events - consumer will create in GraphDB)
    for (const reference of sourceReferences) {
      const referenceId = graphDb.generateId();
      await emitReferenceCreated({
        documentId: newDocId,
        userId: user.id,
        referenceId,
        text: reference.selectionData.text,
        position: {
          offset: reference.selectionData.offset,
          length: reference.selectionData.length,
        },
        entityTypes: reference.entityTypes,
        referenceType: reference.referenceTags?.[0],
        targetDocumentId: reference.resolvedDocumentId || undefined,
      });
      clonedSelections.push({
        id: referenceId,
        documentId: newDocId,
        selectionType: 'reference',
        selectionData: reference.selectionData,
        resolvedDocumentId: reference.resolvedDocumentId,
        entityTypes: reference.entityTypes,
        referenceTags: reference.referenceTags,
        provisional: reference.provisional,
        createdBy: user.id,
        createdAt: new Date().toISOString(),
      });
    }

    // Return optimistic response
    return c.json({
      document: {
        id: newDocId,
        name: body.name,
        archived: false,
        contentType: sourceDoc.contentType,
        metadata: { ...sourceDoc.metadata, clonedFrom: id },
        entityTypes: sourceDoc.entityTypes,
        creationMethod: CREATION_METHODS.API,
        sourceDocumentId: id,
        contentChecksum: checksum,
        createdBy: user.id,
        createdAt: new Date().toISOString(),
      },
      selections: clonedSelections.map(formatSelection),
    }, 201);
  });
}