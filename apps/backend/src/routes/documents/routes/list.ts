import { createRoute, z } from '@hono/zod-openapi';
import { getStorageService } from '../../../storage/filesystem';
import { formatDocument } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import { ListDocumentsResponseSchema } from '@semiont/core-types';
import { DocumentQueryService } from '../../../services/document-queries';

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
    const storage = getStorageService();

    // Read from Layer 3 projection storage
    let filteredDocs = await DocumentQueryService.listDocuments({
      search,
      archived,
    });

    // Additional filter by entity type (Layer 3 already handles search and archived)
    if (entityType) {
      filteredDocs = filteredDocs.filter(doc => doc.entityTypes?.includes(entityType));
    }

    // Paginate
    const paginatedDocs = filteredDocs.slice(offset, offset + limit);

    // Optionally add content snippet for search results
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
      documents: documentsWithContent.map(doc => formatDocument(doc)),
      total: filteredDocs.length,
      offset,
      limit,
    });
  });
}