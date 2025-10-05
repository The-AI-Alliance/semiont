import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getStorageService } from '../../../storage/filesystem';
import { CREATION_METHODS } from '@semiont/core-types';
import { calculateChecksum } from '@semiont/utils';
import { formatAnnotation } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { emitDocumentCloned, emitHighlightAdded, emitReferenceCreated } from '../../../events/emit';
import { generateAnnotationId } from '../../../utils/id-generator';
import { DocumentQueryService } from '../../../services/document-queries';
import { AnnotationQueryService } from '../../../services/annotation-queries';

// Local schema to avoid TypeScript hanging
const CloneDocumentResponse = z.object({
  document: z.any(),
  annotations: z.array(z.any()),
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
    const storage = getStorageService();

    // Read source document metadata from Layer 3
    const sourceDoc = await DocumentQueryService.getDocumentMetadata(id);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source document not found' });
    }

    // Read content from Layer 1
    const content = await storage.getDocument(id);
    const contentStr = content.toString('utf-8');
    const checksum = calculateChecksum(contentStr);
    const newDocId = `doc-sha256:${checksum}`;

    // Save to filesystem (Layer 1)
    await storage.saveDocument(newDocId, content);

    // Subscribe GraphDB consumer to new document BEFORE emitting event
    // This ensures the consumer receives the document.cloned event
    try {
      const { getGraphConsumer } = await import('../../../events/consumers/graph-consumer');
      const consumer = await getGraphConsumer();
      await consumer.subscribeToDocument(newDocId);
    } catch (error) {
      console.error('[CloneDocument] Failed to subscribe GraphDB consumer:', error);
      // Don't fail the request - consumer can catch up later
    }

    // Emit document.cloned event (event store updates Layer 3, graph consumer updates Layer 4)
    await emitDocumentCloned({
      documentId: newDocId,
      userId: user.id,
      name: body.name,
      contentType: sourceDoc.contentType,
      contentHash: checksum,
      parentDocumentId: id,
      entityTypes: sourceDoc.entityTypes,
      metadata: {
        ...sourceDoc.metadata,
        clonedFrom: id,
        creationMethod: CREATION_METHODS.CLONE,
      },
    });

    // Propagate annotations from source document using Layer 3
    // Since content is identical, all text positions remain valid
    const sourceHighlights = await AnnotationQueryService.getHighlights(id);
    const sourceReferences = await AnnotationQueryService.getReferences(id);

    const clonedSelections: any[] = [];

    // Copy highlights to new document (emit events - event store updates Layer 3, graph consumer updates Layer 4)
    for (const highlight of sourceHighlights) {
      const highlightId = generateAnnotationId();
      await emitHighlightAdded({
        documentId: newDocId,
        userId: user.id,
        highlightId,
        text: highlight.text,
        position: {
          offset: highlight.selectionData.offset,
          length: highlight.selectionData.length,
        },
      });
      clonedSelections.push({
        id: highlightId,
        documentId: newDocId,
        selectionType: 'highlight',
        selectionData: {
          text: highlight.text,
          offset: highlight.selectionData.offset,
          length: highlight.selectionData.length,
        },
        entityTypes: [],
        createdBy: user.id,
        createdAt: new Date().toISOString(),
      });
    }

    // Copy references to new document (emit events - event store updates Layer 3, graph consumer updates Layer 4)
    for (const reference of sourceReferences) {
      const referenceId = generateAnnotationId();
      await emitReferenceCreated({
        documentId: newDocId,
        userId: user.id,
        referenceId,
        text: reference.text,
        position: {
          offset: reference.selectionData.offset,
          length: reference.selectionData.length,
        },
        entityTypes: reference.entityTypes || [],
        referenceType: reference.referenceType,
        targetDocumentId: reference.referencedDocumentId || undefined,
      });
      clonedSelections.push({
        id: referenceId,
        documentId: newDocId,
        selectionType: 'reference',
        selectionData: {
          text: reference.text,
          offset: reference.selectionData.offset,
          length: reference.selectionData.length,
        },
        referencedDocumentId: reference.referencedDocumentId,
        entityTypes: reference.entityTypes || [],
        referenceTags: reference.referenceType ? [reference.referenceType] : [],
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
      annotations: clonedSelections.map(formatAnnotation),
    }, 201);
  });
}