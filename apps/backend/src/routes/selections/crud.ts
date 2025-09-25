import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createSelectionRouter, type SelectionsRouterType } from './shared';
import { formatDocument, formatSelection } from './helpers';
import { getGraphDatabase } from '../../graph/factory';
import type { CreateSelectionInput } from '@semiont/core-types';

// Create router with auth middleware
export const crudRouter: SelectionsRouterType = createSelectionRouter();

// Local schemas to avoid TypeScript hanging
const CreateSelectionRequest = z.object({
  documentId: z.string(),
  selectionType: z.enum(['highlight', 'reference']),
  selectionData: z.record(z.string(), z.any()),
  entityTypes: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  provisional: z.boolean().optional(),
});

const CreateSelectionResponse = z.object({
  selection: z.any(),
});

// CREATE
const createSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections',
  summary: 'Create Selection',
  description: 'Create a new selection/reference in a document',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateSelectionRequest,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateSelectionResponse,
        },
      },
      description: 'Selection created successfully',
    },
  },
});
crudRouter.openapi(createSelectionRoute, async (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();

  const selectionInput: CreateSelectionInput = {
    documentId: body.documentId,
    selectionType: body.selectionType,
    selectionData: body.selectionData,
    entityTypes: body.entityTypes,
    provisional: body.provisional ?? true,
    metadata: body.metadata,
    createdBy: user.id,
  };

  const selection = await graphDb.createSelection(selectionInput);

  return c.json({
    selection: formatSelection(selection),
  }, 201);
});

// Local schema for GET
const GetSelectionResponse = z.object({
  selection: z.any(),
  document: z.any().nullable(),
  resolvedDocument: z.any().nullable(),
});

// GET
const getSelectionRoute = createRoute({
  method: 'get',
  path: '/api/selections/{id}',
  summary: 'Get Selection',
  description: 'Get a selection by ID',
  tags: ['Selections'],
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
          schema: GetSelectionResponse,
        },
      },
      description: 'Selection retrieved successfully',
    },
  },
});
crudRouter.openapi(getSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();

  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  const document = await graphDb.getDocument(selection.documentId);
  const resolvedDocument = selection.resolvedDocumentId ?
    await graphDb.getDocument(selection.resolvedDocumentId) : null;

  return c.json({
    selection: formatSelection(selection),
    document: document ? formatDocument(document) : null,
    resolvedDocument: resolvedDocument ? formatDocument(resolvedDocument) : null,
  });
});

// Local schema for LIST
const ListSelectionsResponse = z.object({
  selections: z.array(z.any()),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
});

// LIST
const listSelectionsRoute = createRoute({
  method: 'get',
  path: '/api/selections',
  summary: 'List Selections',
  description: 'List all selections with filters',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      documentId: z.string().optional(),
      resolvedDocumentId: z.string().optional(),
      entityType: z.string().optional(),
      provisional: z.union([
        z.literal('true').transform(() => true),
        z.literal('false').transform(() => false),
        z.boolean()
      ]).optional(),
      offset: z.coerce.number().default(0),
      limit: z.coerce.number().default(50),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListSelectionsResponse,
        },
      },
      description: 'Selections listed successfully',
    },
  },
});
crudRouter.openapi(listSelectionsRoute, async (c) => {
  const query = c.req.valid('query');
  const graphDb = await getGraphDatabase();

  const filters: any = {};
  if (query.documentId) filters.documentId = query.documentId;
  if (query.resolvedDocumentId) filters.resolvedDocumentId = query.resolvedDocumentId;
  if (query.entityType) filters.entityType = query.entityType;
  if (query.provisional !== undefined) filters.provisional = query.provisional;

  const result = await graphDb.listSelections({
    ...filters,
    offset: query.offset,
    limit: query.limit,
  });

  return c.json({
    selections: result.selections.map(formatSelection),
    total: result.total,
    offset: query.offset,
    limit: query.limit,
  });
});

// Local schemas for RESOLVE
const ResolveSelectionRequest = z.object({
  targetDocumentId: z.string(),
});

const ResolveSelectionResponse = z.object({
  selection: z.any(),
  targetDocument: z.any().nullable(),
});

// RESOLVE
const resolveSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections/{id}/resolve',
  summary: 'Resolve Selection',
  description: 'Resolve a provisional selection to a target document',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: ResolveSelectionRequest,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ResolveSelectionResponse,
        },
      },
      description: 'Selection resolved successfully',
    },
  },
});
crudRouter.openapi(resolveSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();

  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  const resolved = await graphDb.resolveSelection({
    selectionId: id,
    targetDocumentId: body.targetDocumentId,
    resolvedBy: user.id
  });

  const targetDocument = await graphDb.getDocument(body.targetDocumentId);

  return c.json({
    selection: formatSelection(resolved),
    targetDocument: targetDocument ? formatDocument(targetDocument) : null,
  });
});

// DELETE
const deleteSelectionRoute = createRoute({
  method: 'delete',
  path: '/api/selections/{id}',
  summary: 'Delete Selection',
  description: 'Delete a selection',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    204: {
      description: 'Selection deleted successfully',
    },
  },
});
crudRouter.openapi(deleteSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();

  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  await graphDb.deleteSelection(id);

  return c.body(null, 204);
});