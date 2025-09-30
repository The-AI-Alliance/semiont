import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import type { Document, CreateDocumentInput } from '@semiont/core-types';
import { CREATION_METHODS } from '@semiont/core-types';
import { calculateChecksum } from '@semiont/utils';
import { formatDocument, formatSelection } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { emitDocumentCloned } from '../../../events/emit';

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

    const document: Document = {
      id: `doc-sha256:${checksum}`,
      name: body.name,
      archived: false,
      contentType: sourceDoc.contentType,
      metadata: { ...sourceDoc.metadata, clonedFrom: id },
      entityTypes: sourceDoc.entityTypes,
      creationMethod: CREATION_METHODS.API,
      sourceDocumentId: id,
      contentChecksum: checksum,
      createdBy: user.id,
      createdAt: new Date(),
    };

    const createInput: CreateDocumentInput = {
      name: document.name,
      entityTypes: document.entityTypes,
      content: contentStr,
      contentType: document.contentType,
      contentChecksum: document.contentChecksum!,
      metadata: document.metadata,
      createdBy: document.createdBy!,
      creationMethod: document.creationMethod,
      sourceDocumentId: document.sourceDocumentId,
    };

    const savedDoc = await graphDb.createDocument(createInput);
    await storage.saveDocument(savedDoc.id, content);

    // Emit document.cloned event
    await emitDocumentCloned({
      documentId: savedDoc.id,
      userId: user.id,
      name: savedDoc.name,
      contentType: savedDoc.contentType,
      contentHash: savedDoc.contentChecksum || checksum,
      parentDocumentId: id,
      entityTypes: savedDoc.entityTypes,
      metadata: savedDoc.metadata,
    });

    // Propagate annotations from source document
    // Since content is identical, all text positions remain valid
    const sourceHighlights = await graphDb.getHighlights(id);
    const sourceReferences = await graphDb.getReferences(id);

    // Copy highlights to new document
    for (const highlight of sourceHighlights) {
      await graphDb.createSelection({
        documentId: savedDoc.id,
        selectionData: highlight.selectionData,
        entityTypes: highlight.entityTypes,
        referenceTags: highlight.referenceTags,
        provisional: highlight.provisional,
        metadata: { ...highlight.metadata, clonedFrom: highlight.id },
        createdBy: user.id,
      });
    }

    // Copy references to new document
    for (const reference of sourceReferences) {
      await graphDb.createSelection({
        documentId: savedDoc.id,
        selectionData: reference.selectionData,
        resolvedDocumentId: reference.resolvedDocumentId,
        entityTypes: reference.entityTypes,
        referenceTags: reference.referenceTags,
        provisional: reference.provisional,
        metadata: { ...reference.metadata, clonedFrom: reference.id },
        createdBy: user.id,
      });
    }

    const highlights = await graphDb.getHighlights(savedDoc.id);
    const references = await graphDb.getReferences(savedDoc.id);

    return c.json({
      document: formatDocument(savedDoc),
      selections: [...highlights, ...references].map(formatSelection),
    }, 201);
  });
}