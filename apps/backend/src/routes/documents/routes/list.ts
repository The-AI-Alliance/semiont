import { createRoute, z } from '@hono/zod-openapi';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { formatDocument } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { ListDocumentsResponseSchema } from '../schemas';

export const listDocumentsRoute = createRoute({
  method: 'get',
  path: '/api/documents',
  summary: 'List Documents',
  description: 'List all documents with optional filters',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      offset: z.coerce.number().default(0),
      limit: z.coerce.number().default(50),
      entityType: z.string().optional(),
      archived: z.union([
        z.literal('true').transform(() => true),
        z.literal('false').transform(() => false),
        z.boolean()
      ]).optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListDocumentsResponseSchema,
        },
      },
      description: 'Documents listed successfully',
    },
  },
});

export function registerListDocuments(router: DocumentsRouterType) {
  router.openapi(listDocumentsRoute, async (c) => {
    const { offset, limit, entityType, archived, search } = c.req.valid('query');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const allDocs = await graphDb.listDocuments({});
    let filteredDocs = allDocs.documents;

    if (search) {
      const searchLower = search.toLowerCase();
      filteredDocs = filteredDocs.filter(doc =>
        doc.name.toLowerCase().includes(searchLower)
      );
    }

    if (entityType) {
      filteredDocs = filteredDocs.filter(doc => doc.entityTypes?.includes(entityType));
    }
    if (archived !== undefined) {
      filteredDocs = filteredDocs.filter(doc => doc.archived === archived);
    }

    const paginatedDocs = filteredDocs.slice(offset, offset + limit);

    let documentsWithContent = paginatedDocs;
    if (search) {
      documentsWithContent = await Promise.all(
        paginatedDocs.map(async (doc) => {
          try {
            const contentBuffer = await storage.getDocument(doc.id);
            const contentStr = contentBuffer.toString('utf-8');
            return { ...doc, content: contentStr.slice(0, 200) };
          } catch {
            return { ...doc, content: '' };
          }
        })
      );
    }

    return c.json({
      documents: documentsWithContent.map(formatDocument),
      total: filteredDocs.length,
      offset,
      limit,
    });
  });
}