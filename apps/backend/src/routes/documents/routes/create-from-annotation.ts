import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import type { Document, CreateDocumentInput } from '@semiont/sdk';
import { CREATION_METHODS } from '@semiont/sdk';
import { calculateChecksum } from '@semiont/utils';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';

// Local schemas to avoid TypeScript hanging
const CreateFromSelectionRequest = z.object({
  name: z.string(),
  content: z.string(),
  format: z.string(), // Required - caller must specify MIME type
  metadata: z.record(z.string(), z.any()).optional(),
});

const CreateFromAnnotationResponse = z.object({
  document: z.any(),
  annotations: z.array(z.any()),
});

type CreateFromAnnotationResponse = z.infer<typeof CreateFromAnnotationResponse>;

export const createDocumentFromAnnotationRoute = createRoute({
  method: 'post',
  path: '/api/documents/from-annotation/{annotationId}',
  summary: 'Create Document from Annotation',
  description: 'Create a new document from an annotation/reference',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      annotationId: z.string(),
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
          schema: CreateFromAnnotationResponse,
        },
      },
      description: 'Document created from annotation',
    },
  },
});

export function registerCreateDocumentFromAnnotation(router: DocumentsRouterType) {
  router.openapi(createDocumentFromAnnotationRoute, async (c) => {
    const { annotationId } = c.req.valid('param');
    const body = c.req.valid('json');
    const user = c.get('user');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const annotation = await AnnotationQueryService.getAnnotation(annotationId);
    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    const checksum = calculateChecksum(body.content);
    const document: Document = {
      id: Math.random().toString(36).substring(2, 11),
      name: body.name,
      archived: false,
      format: body.format,
      entityTypes: annotation.body.entityTypes,
      creationMethod: CREATION_METHODS.REFERENCE,
      sourceAnnotationId: annotationId,
      sourceDocumentId: annotation.target.source,
      contentChecksum: checksum,
      creator: user.id,
      created: new Date().toISOString(),
    };

    const documentId = `doc-sha256:${checksum}`;

    const createInput: CreateDocumentInput & { id: string } = {
      id: documentId,
      name: document.name,
      entityTypes: document.entityTypes,
      content: body.content,
      format: document.format,
      contentChecksum: document.contentChecksum!,
      creator: document.creator!,
      creationMethod: document.creationMethod,
      sourceAnnotationId: document.sourceAnnotationId,
      sourceDocumentId: document.sourceDocumentId,
    };

    const savedDoc = await graphDb.createDocument(createInput);
    await storage.saveDocument(documentId, Buffer.from(body.content));

    // Update the annotation to resolve to the new document
    await graphDb.resolveReference(annotationId, savedDoc.id);

    const highlights = await graphDb.getHighlights(savedDoc.id);
    const references = await graphDb.getReferences(savedDoc.id);

    const response: CreateFromAnnotationResponse = {
      document: savedDoc,
      annotations: [...highlights, ...references],
    };

    return c.json(response, 201);
  });
}