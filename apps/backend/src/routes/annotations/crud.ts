import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createAnnotationRouter, type AnnotationsRouterType } from './shared';
import { emitHighlightAdded, emitHighlightRemoved, emitReferenceCreated, emitReferenceResolved, emitReferenceDeleted } from '../../events/emit';
import {
  CreateAnnotationRequestSchema,
  CreateAnnotationResponseSchema,
  ResolveAnnotationRequestSchema,
  ResolveAnnotationResponseSchema,
  DeleteAnnotationRequestSchema,
  GetAnnotationResponseSchema,
  ListAnnotationsResponseSchema,
  getExactText,
  getTextPositionSelector,
  type CreateAnnotationResponse,
  type ResolveAnnotationResponse,
  type GetAnnotationResponse,
  type ListAnnotationsResponse,
} from '@semiont/core-types';
import { generateAnnotationId, userToDid } from '../../utils/id-generator';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { DocumentQueryService } from '../../services/document-queries';

// Create router with auth middleware
export const crudRouter: AnnotationsRouterType = createAnnotationRouter();

// CREATE
const createAnnotationRoute = createRoute({
  method: 'post',
  path: '/api/annotations',
  summary: 'Create Annotation',
  description: 'Create a new annotation/reference in a document',
  tags: ['Annotations'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateAnnotationRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateAnnotationResponseSchema,
        },
      },
      description: 'Annotation created successfully',
    },
  },
});
crudRouter.openapi(createAnnotationRoute, async (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');

  // Generate ID - backend-internal, not graph-dependent
  let annotationId: string;
  try {
    annotationId = generateAnnotationId();
  } catch (error) {
    console.error('Failed to generate annotation ID:', error);
    throw new HTTPException(500, { message: 'Failed to create annotation' });
  }
  const isReference = body.body.type === 'SpecificResource';

  // Extract TextPositionSelector for event (events require offset/length)
  const posSelector = getTextPositionSelector(body.target.selector);
  if (!posSelector) {
    throw new HTTPException(400, { message: 'TextPositionSelector required for creating annotations' });
  }

  // Emit event first (single source of truth)
  if (isReference) {
    await emitReferenceCreated({
      documentId: body.target.source,
      userId: user.id,
      referenceId: annotationId,
      exact: getExactText(body.target.selector),
      position: {
        offset: posSelector.offset,
        length: posSelector.length,
      },
      entityTypes: body.body.entityTypes || [],
      targetDocumentId: body.body.source ?? undefined,
    });
  } else {
    await emitHighlightAdded({
      documentId: body.target.source,
      userId: user.id,
      highlightId: annotationId,
      exact: getExactText(body.target.selector),
      position: {
        offset: posSelector.offset,
        length: posSelector.length,
      },
    });
  }

  // Return optimistic response (consumer will update GraphDB async)
  const response: CreateAnnotationResponse = {
    annotation: {
      id: annotationId,
      motivation: body.body.type === 'TextualBody' ? 'highlighting' : 'linking',
      target: {
        source: body.target.source,
        selector: body.target.selector,
      },
      body: {
        type: body.body.type,
        value: body.body.value,
        entityTypes: body.body.entityTypes || [],
        source: body.body.source,
      },
      creator: {
        type: 'Person' as const,
        id: userToDid(user),
        name: user.name || user.email,
      },
      created: new Date().toISOString(),
    },
  };

  return c.json(response, 201);
});

// RESOLVE - Must come BEFORE GET to avoid {id} matching "/resolve"
const resolveAnnotationRoute = createRoute({
  method: 'put',
  path: '/api/annotations/{id}/resolve',
  summary: 'Resolve Annotation',
  description: 'Resolve a reference annotation to a target document',
  tags: ['Annotations'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: ResolveAnnotationRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ResolveAnnotationResponseSchema,
        },
      },
      description: 'Annotation resolved successfully',
    },
  },
});
crudRouter.openapi(resolveAnnotationRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  console.log(`[RESOLVE HANDLER] Called for annotation ${id}, body:`, body);

  // Get annotation from Layer 3 (event store projection)
  const annotation = await AnnotationQueryService.getAnnotation(id);
  console.log(`[RESOLVE HANDLER] Layer 3 lookup result for ${id}:`, annotation ? 'FOUND' : 'NOT FOUND');

  if (!annotation) {
    console.log(`[RESOLVE HANDLER] Throwing 404 - annotation ${id} not found in Layer 3`);
    throw new HTTPException(404, { message: 'Annotation not found' });
  }

  // Emit reference.resolved event to Layer 2 (consumer will update Layer 3 projection)
  await emitReferenceResolved({
    documentId: annotation.target.source,
    userId: user.id,
    referenceId: id,
    targetDocumentId: body.documentId,
  });

  // Get target document from Layer 3
  const targetDocument = await DocumentQueryService.getDocumentMetadata(body.documentId);

  // Return optimistic response
  const response: ResolveAnnotationResponse = {
    annotation: {
      ...annotation,
      body: {
        ...annotation.body,
        source: body.documentId,
      },
    },
    targetDocument,
  };

  return c.json(response);
});

// GET
const getAnnotationRoute = createRoute({
  method: 'get',
  path: '/api/annotations/{id}',
  summary: 'Get Annotation',
  description: 'Get an annotation by ID (requires documentId query param for O(1) Layer 3 lookup)',
  tags: ['Annotations'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: z.object({
      documentId: z.string().describe('Document ID containing the annotation'),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GetAnnotationResponseSchema,
        },
      },
      description: 'Annotation retrieved successfully',
    },
  },
});
crudRouter.openapi(getAnnotationRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { documentId } = c.req.valid('query');

  // O(1) lookup in Layer 3 using document ID
  const projection = await AnnotationQueryService.getDocumentAnnotations(documentId);

  // Find the annotation in this document's annotations
  const annotation = projection.highlights.find((h) => h.id === id) ||
                    projection.references.find((r) => r.id === id);

  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found in document' });
  }

  // Get document metadata from Layer 3
  const document = await DocumentQueryService.getDocumentMetadata(documentId);
  const resolvedDocument = annotation.body.source ?
    await DocumentQueryService.getDocumentMetadata(annotation.body.source) : null;

  const response: GetAnnotationResponse = {
    annotation,
    document,
    resolvedDocument,
  };

  return c.json(response);
});

// LIST
const listAnnotationsRoute = createRoute({
  method: 'get',
  path: '/api/annotations',
  summary: 'List Annotations',
  description: 'List all annotations for a document (requires documentId for O(1) Layer 3 lookup)',
  tags: ['Annotations'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      documentId: z.string().describe('Document ID to list annotations for'),
      offset: z.coerce.number().default(0),
      limit: z.coerce.number().default(50),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListAnnotationsResponseSchema,
        },
      },
      description: 'Annotations listed successfully',
    },
  },
});
crudRouter.openapi(listAnnotationsRoute, async (c) => {
  const query = c.req.valid('query');

  // O(1) lookup in Layer 3 using document ID
  const projection = await AnnotationQueryService.getDocumentAnnotations(query.documentId);

  // Combine highlights and references
  const allAnnotations = [...projection.highlights, ...projection.references];

  // Apply pagination
  const paginatedAnnotations = allAnnotations.slice(query.offset, query.offset + query.limit);

  const response: ListAnnotationsResponse = {
    annotations: paginatedAnnotations,
    total: allAnnotations.length,
    offset: query.offset,
    limit: query.limit,
  };

  return c.json(response);
});

// DELETE
const deleteAnnotationRoute = createRoute({
  method: 'delete',
  path: '/api/annotations/{id}',
  summary: 'Delete Annotation',
  description: 'Delete an annotation (requires documentId in body for O(1) Layer 3 lookup)',
  tags: ['Annotations'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: DeleteAnnotationRequestSchema,
        },
      },
    },
  },
  responses: {
    204: {
      description: 'Annotation deleted successfully',
    },
    404: {
      description: 'Annotation not found',
    },
  },
});
crudRouter.openapi(deleteAnnotationRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');

  // O(1) lookup in Layer 3 using document ID
  const projection = await AnnotationQueryService.getDocumentAnnotations(body.documentId);

  // Find the annotation in this document's annotations
  const highlight = projection.highlights.find((h: any) => h.id === id);
  const reference = projection.references.find((r: any) => r.id === id);
  const annotation = highlight || reference;

  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found in document' });
  }

  // Emit event first (consumer will delete from GraphDB and update Layer 3)
  if (reference) {
    console.log('[DeleteAnnotation] Emitting reference.deleted event for:', id);
    const storedEvent = await emitReferenceDeleted({
      documentId: body.documentId,
      userId: user.id,
      referenceId: id,
    });
    console.log('[DeleteAnnotation] Event emitted, sequence:', storedEvent.metadata.sequenceNumber);
  } else {
    // It's a highlight
    console.log('[DeleteAnnotation] Emitting highlight.removed event for:', id);
    const storedEvent = await emitHighlightRemoved({
      documentId: body.documentId,
      userId: user.id,
      highlightId: id,
    });
    console.log('[DeleteAnnotation] Event emitted, sequence:', storedEvent.metadata.sequenceNumber);
  }

  return c.body(null, 204);
});