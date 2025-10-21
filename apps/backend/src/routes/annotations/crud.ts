/**
 * Annotation CRUD Routes - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request bodies with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 *
 * Routes:
 * - POST /api/annotations (create)
 * - PUT /api/annotations/:id/resolve (resolve reference)
 * - GET /api/annotations/:id (get single)
 * - GET /api/annotations (list)
 * - DELETE /api/annotations/:id (delete)
 */

import { HTTPException } from 'hono/http-exception';
import { createAnnotationRouter, type AnnotationsRouterType } from './shared';
import { getEventStore } from '../../events/event-store';
import {
  getTextPositionSelector,
  type Annotation,
  type AnnotationAddedEvent,
} from '@semiont/core';
import { generateAnnotationId, userToAgent } from '../../utils/id-generator';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { DocumentQueryService } from '../../services/document-queries';
import { validateRequestBody } from '../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type CreateAnnotationResponse = components['schemas']['CreateAnnotationResponse'];
type ResolveAnnotationRequest = components['schemas']['ResolveAnnotationRequest'];
type ResolveAnnotationResponse = components['schemas']['ResolveAnnotationResponse'];
type DeleteAnnotationRequest = components['schemas']['DeleteAnnotationRequest'];
type GetAnnotationResponse = components['schemas']['GetAnnotationResponse'];
type ListAnnotationsResponse = components['schemas']['ListAnnotationsResponse'];

// Create router with auth middleware
export const crudRouter: AnnotationsRouterType = createAnnotationRouter();

/**
 * POST /api/annotations
 * Create a new annotation/reference in a document
 */
crudRouter.post('/api/annotations',
  validateRequestBody('CreateAnnotationRequest'),
  async (c) => {
    const request = c.get('validatedBody') as CreateAnnotationRequest;
    const user = c.get('user');

    // Generate ID - backend-internal, not graph-dependent
    let annotationId: string;
    try {
      annotationId = generateAnnotationId();
    } catch (error) {
      console.error('Failed to generate annotation ID:', error);
      throw new HTTPException(500, { message: 'Failed to create annotation' });
    }
    // Extract TextPositionSelector for event (events require offset/length)
    const posSelector = getTextPositionSelector(request.target.selector);
    if (!posSelector) {
      throw new HTTPException(400, { message: 'TextPositionSelector required for creating annotations' });
    }

    // Determine motivation: use provided value or default based on body type
    const motivation = request.motivation || (request.body.type === 'TextualBody' ? 'highlighting' : 'linking');

    // Build annotation object (Omit<Annotation, 'creator' | 'created'>)
    const annotation: Omit<Annotation, 'creator' | 'created'> = {
      id: annotationId,
      motivation: motivation,
      target: {
        source: request.target.source,
        selector: request.target.selector,
      },
      body: {
        type: request.body.type,
        value: request.body.value,
        entityTypes: request.body.entityTypes || [],
        source: request.body.source,
      },
      modified: new Date().toISOString(),
    };

    // Emit unified annotation.added event (single source of truth)
    const eventStore = await getEventStore();
    const eventPayload: Omit<AnnotationAddedEvent, 'id' | 'timestamp'> = {
      type: 'annotation.added',
      documentId: request.target.source,
      userId: user.id,
      version: 1,
      payload: {
        annotation,
      },
    };
    await eventStore.appendEvent(eventPayload);

    // Return optimistic response (consumer will update GraphDB async)
    const response: CreateAnnotationResponse = {
      annotation: {
        id: annotationId,
        motivation: motivation,
        target: {
          source: request.target.source,
          selector: request.target.selector,
        },
        body: {
          type: request.body.type,
          value: request.body.value,
          entityTypes: request.body.entityTypes || [],
          source: request.body.source,
        },
        creator: userToAgent(user),
        created: new Date().toISOString(),
      },
    };

    return c.json(response, 201);
  }
);

/**
 * PUT /api/annotations/:id/resolve
 * Resolve a reference annotation to a target document
 * MUST come BEFORE GET to avoid {id} matching "/resolve"
 */
crudRouter.put('/api/annotations/:id/resolve',
  validateRequestBody('ResolveAnnotationRequest'),
  async (c) => {
    const { id } = c.req.param();
    const request = c.get('validatedBody') as ResolveAnnotationRequest;
    const user = c.get('user');

    console.log(`[RESOLVE HANDLER] Called for annotation ${id}, request:`, request);

    // Get annotation from Layer 3 (event store projection)
    const annotation = await AnnotationQueryService.getAnnotation(id, request.documentId);
    console.log(`[RESOLVE HANDLER] Layer 3 lookup result for ${id}:`, annotation ? 'FOUND' : 'NOT FOUND');

    if (!annotation) {
      console.log(`[RESOLVE HANDLER] Throwing 404 - annotation ${id} not found in Layer 3`);
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    // Emit annotation.resolved event to Layer 2 (consumer will update Layer 3 projection)
    const eventStore = await getEventStore();
    await eventStore.appendEvent({
      type: 'annotation.resolved',
      documentId: annotation.target.source,
      userId: user.id,
      version: 1,
      payload: {
        annotationId: id,
        targetDocumentId: request.documentId,
      },
    });

    // Get target document from Layer 3
    const targetDocument = await DocumentQueryService.getDocumentMetadata(request.documentId);

    // Return optimistic response
    const response: ResolveAnnotationResponse = {
      annotation: {
        ...annotation,
        body: {
          ...annotation.body,
          source: request.documentId,
        },
      },
      targetDocument,
    };

    return c.json(response);
  }
);

/**
 * GET /api/annotations/:id
 * Get an annotation by ID (requires documentId query param for O(1) Layer 3 lookup)
 */
crudRouter.get('/api/annotations/:id', async (c) => {
  const { id } = c.req.param();
  const query = c.req.query();
  const documentId = query.documentId;

  if (!documentId) {
    throw new HTTPException(400, { message: 'documentId query parameter is required' });
  }

  // O(1) lookup in Layer 3 using document ID
  const projection = await AnnotationQueryService.getDocumentAnnotations(documentId);

  // Find the annotation
  const annotation = projection.annotations.find((a: Annotation) => a.id === id);

  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found in document' });
  }

  // Get document metadata
  const document = await DocumentQueryService.getDocumentMetadata(documentId);

  // If it's a linking annotation with a source, get resolved document
  let resolvedDocument = null;
  if (annotation.motivation === 'linking' && annotation.body.source) {
    resolvedDocument = await DocumentQueryService.getDocumentMetadata(annotation.body.source);
  }

  const response: GetAnnotationResponse = {
    annotation,
    document,
    resolvedDocument,
  };

  return c.json(response);
});

/**
 * GET /api/annotations
 * List all annotations for a document (requires documentId for O(1) Layer 3 lookup)
 */
crudRouter.get('/api/annotations', async (c) => {
  const query = c.req.query();
  const documentId = query.documentId;
  const offset = Number(query.offset) || 0;
  const limit = Number(query.limit) || 50;

  if (!documentId) {
    throw new HTTPException(400, { message: 'documentId query parameter is required' });
  }

  // O(1) lookup in Layer 3 using document ID
  const projection = await AnnotationQueryService.getDocumentAnnotations(documentId);

  // Apply pagination to all annotations
  const paginatedAnnotations = projection.annotations.slice(offset, offset + limit);

  const response: ListAnnotationsResponse = {
    annotations: paginatedAnnotations,
    total: projection.annotations.length,
    offset: offset,
    limit: limit,
  };

  return c.json(response);
});

/**
 * DELETE /api/annotations/:id
 * Delete an annotation (requires documentId in body for O(1) Layer 3 lookup)
 */
crudRouter.delete('/api/annotations/:id',
  validateRequestBody('DeleteAnnotationRequest'),
  async (c) => {
    const { id } = c.req.param();
    const request = c.get('validatedBody') as DeleteAnnotationRequest;
    const user = c.get('user');

    // O(1) lookup in Layer 3 using document ID
    const projection = await AnnotationQueryService.getDocumentAnnotations(request.documentId);

    // Find the annotation in this document's annotations
    const annotation = projection.annotations.find((a: Annotation) => a.id === id);

    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found in document' });
    }

    // Emit unified annotation.removed event (consumer will delete from GraphDB and update Layer 3)
    const eventStore = await getEventStore();
    console.log('[DeleteAnnotation] Emitting annotation.removed event for:', id);
    const storedEvent = await eventStore.appendEvent({
      type: 'annotation.removed',
      documentId: request.documentId,
      userId: user.id,
      version: 1,
      payload: {
        annotationId: id,
      },
    });
    console.log('[DeleteAnnotation] Event emitted, sequence:', storedEvent.metadata.sequenceNumber);

    return c.body(null, 204);
  }
);
