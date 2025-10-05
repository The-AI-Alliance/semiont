import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import type { Document, CreateDocumentInput } from '@semiont/core-types';
import { CREATION_METHODS } from '@semiont/core-types';
import { calculateChecksum } from '@semiont/utils';
import { formatDocument, formatAnnotation } from '../helpers';
import type { DocumentsRouterType } from '../shared';

// Local schemas to avoid TypeScript hanging
const CreateFromSelectionRequest = z.object({
  name: z.string(),
  content: z.string(),
  contentType: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const CreateFromSelectionResponse = z.object({
  document: z.any(),
  selections: z.array(z.any()),
});

export const createDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/documents/from-selection/{selectionId}',
  summary: 'Create Document from Selection',
  description: 'Create a new document from a selection/reference',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      selectionId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateFromSelectionRequest,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateFromSelectionResponse,
        },
      },
      description: 'Document created from selection',
    },
  },
});

export function registerCreateDocumentFromSelection(router: DocumentsRouterType) {
  router.openapi(createDocumentFromSelectionRoute, async (c) => {
    const { selectionId } = c.req.valid('param');
    const body = c.req.valid('json');
    const user = c.get('user');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const selection = await graphDb.getAnnotation(selectionId);
    if (!selection) {
      throw new HTTPException(404, { message: 'Selection not found' });
    }

    const checksum = calculateChecksum(body.content);
    const document: Document = {
      id: Math.random().toString(36).substring(2, 11),
      name: body.name,
      archived: false,
      contentType: body.contentType || 'text/plain',
      metadata: { ...body.metadata, createdFromSelection: selectionId },
      entityTypes: selection.entityTypes || [],
      creationMethod: CREATION_METHODS.REFERENCE,
      sourceSelectionId: selectionId,
      sourceDocumentId: selection.documentId,
      contentChecksum: checksum,
      createdBy: user.id,
      createdAt: new Date(),
    };

    const documentId = `doc-sha256:${checksum}`;

    const createInput: CreateDocumentInput & { id: string } = {
      id: documentId,
      name: document.name,
      entityTypes: document.entityTypes,
      content: body.content,
      contentType: document.contentType,
      contentChecksum: document.contentChecksum!,
      metadata: document.metadata,
      createdBy: document.createdBy!,
      creationMethod: document.creationMethod,
      sourceSelectionId: document.sourceSelectionId,
      sourceDocumentId: document.sourceDocumentId,
    };

    const savedDoc = await graphDb.createDocument(createInput);
    await storage.saveDocument(documentId, Buffer.from(body.content));

    // Update the selection to resolve to the new document
    await graphDb.resolveReference(selectionId, savedDoc.id);

    const highlights = await graphDb.getHighlights(savedDoc.id);
    const references = await graphDb.getReferences(savedDoc.id);

    return c.json({
      document: formatDocument(savedDoc),
      selections: [...highlights, ...references].map(formatAnnotation),
    }, 201);
  });
}