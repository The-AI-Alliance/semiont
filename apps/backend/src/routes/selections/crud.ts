import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createSelectionRouter, type SelectionsRouterType } from './shared';
import { formatDocument, formatSelection } from './helpers';
import { getGraphDatabase } from '../../graph/factory';
import { emitHighlightAdded, emitHighlightRemoved, emitReferenceCreated, emitReferenceResolved, emitReferenceDeleted } from '../../events/emit';

// Create router with auth middleware
export const crudRouter: SelectionsRouterType = createSelectionRouter();

// Local schemas to avoid TypeScript hanging
const CreateSelectionRequest = z.object({
  documentId: z.string(),
  selectionType: z.union([
    z.enum(['highlight', 'reference']),
    z.object({
      type: z.string(),
      offset: z.number(),
      length: z.number(),
      text: z.string()
    })
  ]),
  selectionData: z.record(z.string(), z.any()).optional(),
  entityTypes: z.array(z.string()).optional(),
  referenceTags: z.array(z.string()).optional(),
  resolvedDocumentId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
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

  // Process selection data from frontend format
  let selectionData: any = {};

  if (typeof body.selectionType === 'object' && 'type' in body.selectionType) {
    // Frontend format with object - keep the same structure
    const st = body.selectionType;
    selectionData = {
      type: st.type,
      offset: st.offset,
      length: st.length,
      text: st.text
    };
  } else {
    selectionData = body.selectionData || {};
  }

  // Generate ID upfront (deterministic)
  const selectionId = graphDb.generateId();
  const isReference = body.resolvedDocumentId !== undefined;

  // Emit event first (single source of truth)
  if (isReference) {
    await emitReferenceCreated({
      documentId: body.documentId,
      userId: user.id,
      referenceId: selectionId,
      text: selectionData.text,
      position: {
        offset: selectionData.offset,
        length: selectionData.length,
      },
      entityTypes: body.entityTypes,
      referenceType: body.referenceTags?.[0],
      targetDocumentId: body.resolvedDocumentId ?? undefined,
    });
  } else {
    await emitHighlightAdded({
      documentId: body.documentId,
      userId: user.id,
      highlightId: selectionId,
      text: selectionData.text,
      position: {
        offset: selectionData.offset,
        length: selectionData.length,
      },
    });
  }

  // Return optimistic response (consumer will update GraphDB async)
  return c.json({
    selection: {
      id: selectionId,
      documentId: body.documentId,
      selectionType: isReference ? 'reference' : 'highlight',
      selectionData,
      resolvedDocumentId: body.resolvedDocumentId,
      entityTypes: body.entityTypes || [],
      referenceTags: body.referenceTags || [],
      metadata: body.metadata || {},
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    },
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
  documentId: z.string(),
});

const ResolveSelectionResponse = z.object({
  selection: z.any(),
  targetDocument: z.any().nullable(),
});

// RESOLVE
const resolveSelectionRoute = createRoute({
  method: 'put',
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

  // Emit reference.resolved event (consumer will update GraphDB)
  await emitReferenceResolved({
    documentId: selection.documentId,
    userId: user.id,
    referenceId: id,
    targetDocumentId: body.documentId,
    referenceType: selection.referenceTags?.[0],
  });

  const targetDocument = await graphDb.getDocument(body.documentId);

  // Return optimistic response
  return c.json({
    selection: formatSelection({
      ...selection,
      resolvedDocumentId: body.documentId,
    }),
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
  const user = c.get('user');
  const graphDb = await getGraphDatabase();

  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  // Emit event first (consumer will delete from GraphDB)
  if (selection.resolvedDocumentId !== null && selection.resolvedDocumentId !== undefined) {
    // It's a reference
    await emitReferenceDeleted({
      documentId: selection.documentId,
      userId: user.id,
      referenceId: id,
    });
  } else {
    // It's a highlight
    await emitHighlightRemoved({
      documentId: selection.documentId,
      userId: user.id,
      highlightId: id,
    });
  }

  return c.body(null, 204);
});