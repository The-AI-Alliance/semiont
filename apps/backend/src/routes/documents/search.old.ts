import { createRoute, z } from '@hono/zod-openapi';
import { createDocumentRouter, type DocumentsRouterType } from './shared';
import { formatDocument, formatSelection } from './helpers';
import { ListDocumentsResponseSchema } from '@semiont/api-contracts';
import { getGraphDatabase } from '../../graph/factory';
import { getStorageService } from '../../storage/filesystem';
import type { Document } from '@semiont/core-types';

// Create router with auth middleware
export const searchRouter: DocumentsRouterType = createDocumentRouter();

// SEARCH
const searchDocumentsRoute = createRoute({
  method: 'get',
  path: '/api/documents/search',
  summary: 'Search Documents',
  description: 'Search documents by name',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z.string().min(1),
      limit: z.coerce.number().default(10),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListDocumentsResponseSchema,
        },
      },
      description: 'Search results',
    },
  },
});
searchRouter.openapi(searchDocumentsRoute, async (c) => {
  const { q, limit } = c.req.valid('query');
  const graphDb = await getGraphDatabase();

  const allDocs = await graphDb.listDocuments({});

  // Simple case-insensitive search in document names
  const query = q.toLowerCase();
  const matchingDocs = allDocs.documents
    .filter((doc: Document) => doc.name.toLowerCase().includes(query))
    .slice(0, limit);

  return c.json({
    documents: matchingDocs.map(formatDocument),
    total: matchingDocs.length,
    offset: 0,
    limit,
  });
});

// GET REFERENCED BY
const getReferencedByRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/referenced-by',
  summary: 'Get Referenced By',
  description: 'Get documents that reference this document',
  tags: ['Documents', 'Graph'],
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
          schema: z.object({
            documents: z.array(z.any()),
            references: z.array(z.any()),
          }),
        },
      },
      description: 'Referencing documents',
    },
  },
});
searchRouter.openapi(getReferencedByRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();

  // Find all selections that resolve to this document
  const referencingDocs = await graphDb.getDocumentsReferencingDocument(id);

  // Get the actual references/selections
  const references = await graphDb.getReferencesToDocument(id);

  return c.json({
    documents: referencingDocs.map(formatDocument),
    references: references.map(formatSelection),
  });
});

// DISCOVER CONTEXT
const discoverContextRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/discover-context',
  summary: 'Discover Context',
  description: 'Discover related documents and concepts',
  tags: ['Documents', 'Graph'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            depth: z.number().min(1).max(3).default(2),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            documents: z.array(z.any()),
            connections: z.array(z.object({
              fromId: z.string(),
              toId: z.string(),
              type: z.string(),
              metadata: z.any(),
            })),
          }),
        },
      },
      description: 'Context discovery results',
    },
  },
});
searchRouter.openapi(discoverContextRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { depth } = c.req.valid('json');
  const graphDb = await getGraphDatabase();

  // Get connected documents up to the specified depth
  const connectedDocs = await graphDb.getConnectedDocuments(id, depth);

  // Get the connections between documents
  const connections = await graphDb.getDocumentConnections(id, depth);

  return c.json({
    documents: connectedDocs.map(formatDocument),
    connections: connections.map(conn => ({
      fromId: conn.sourceId,
      toId: conn.targetId,
      type: conn.connectionType,
      metadata: conn.metadata,
    })),
  });
});