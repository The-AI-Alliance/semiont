import { createRoute, z } from '@hono/zod-openapi';
import { getStorageService } from '../../../storage/filesystem';
import { formatSearchResult } from '../helpers';
import type { DocumentsRouterType } from '../shared';
import {
  ListDocumentsResponseSchema as ListDocumentsResponseSchema,
  type ListDocumentsResponse,
} from '@semiont/sdk';
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
          schema: ListDocumentsResponseSchema as any,
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
    // For search results, include content preview for better UX
    let formattedDocs;
    if (search) {
      formattedDocs = await Promise.all(
        paginatedDocs.map(async (doc) => {
          try {
            const contentBuffer = await storage.getDocument(doc.id);
            const contentPreview = contentBuffer.toString('utf-8').slice(0, 200);
            return formatSearchResult(doc, contentPreview);
          } catch {
            return formatSearchResult(doc, '');
          }
        })
      );
    } else {
      formattedDocs = paginatedDocs;
    }

    const response: ListDocumentsResponse = {
      documents: formattedDocs,
      total: filteredDocs.length,
      offset,
      limit,
    };

    return c.json(response);
  });
}