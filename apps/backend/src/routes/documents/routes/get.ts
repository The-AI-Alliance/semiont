import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getEventStore } from '../../../events/event-store';
import { getStorageService } from '../../../storage/filesystem';
import type { DocumentsRouterType } from '../shared';
import { GetDocumentResponseSchema } from '../schemas';

export const getDocumentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}',
  summary: 'Get Document',
  description: 'Get a document by ID',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GetDocumentResponseSchema,
        },
      },
      description: 'Document retrieved successfully',
    },
  },
});

export function registerGetDocument(router: DocumentsRouterType) {
  router.openapi(getDocumentRoute, async (c) => {
    const { id } = c.req.valid('param');

    // Read from Layer 2/3: Event store builds/loads projection
    const eventStore = await getEventStore();
    const projection = await eventStore.projectDocument(id);

    if (!projection) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Read content from Layer 1: Filesystem
    const storage = getStorageService();
    let content: string;
    try {
      const contentBuffer = await storage.getDocument(id);
      content = contentBuffer.toString('utf-8');
    } catch (error) {
      throw new HTTPException(404, { message: 'Document content not found in filesystem' });
    }

    // Build selections from projection highlights and references
    const selections = [
      ...projection.highlights.map(h => ({
        id: h.id,
        documentId: id,
        selectionType: 'highlight' as const,
        selectionData: {
          text: h.text,
          offset: h.position.offset,
          length: h.position.length,
        },
        entityTypes: [],
        createdBy: '',
        createdAt: projection.createdAt,
      })),
      ...projection.references.map(r => ({
        id: r.id,
        documentId: id,
        selectionType: 'reference' as const,
        selectionData: {
          text: r.text,
          offset: r.position.offset,
          length: r.position.length,
        },
        resolvedDocumentId: r.targetDocumentId,
        entityTypes: r.entityTypes || [],
        referenceTags: r.referenceType ? [r.referenceType] : [],
        createdBy: '',
        createdAt: projection.createdAt,
      })),
    ];

    const highlights = selections.filter(s => s.selectionType === 'highlight');
    const references = selections.filter(s => s.selectionType === 'reference');
    const entityReferences = references.filter(ref => ref.entityTypes && ref.entityTypes.length > 0);

    return c.json({
      document: {
        id: projection.id,
        name: projection.name,
        content,
        archived: projection.archived,
        contentType: projection.contentType,
        entityTypes: projection.entityTypes,
        metadata: {},
        creationMethod: 'api',
        contentChecksum: '',
        createdBy: '',
        createdAt: projection.createdAt,
      },
      selections,
      highlights,
      references,
      entityReferences,
    });
  });
}