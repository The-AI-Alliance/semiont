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
 * - PUT /api/annotations/:id/body (update annotation body)
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
  type BodyOperation,
} from '@semiont/core';
import { getBodySource, getTargetSource } from '../../lib/annotation-utils';
import { generateAnnotationId, userToAgent } from '../../utils/id-generator';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { DocumentQueryService } from '../../services/document-queries';
import { validateRequestBody } from '../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type CreateAnnotationResponse = components['schemas']['CreateAnnotationResponse'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];
type UpdateAnnotationBodyResponse = components['schemas']['UpdateAnnotationBodyResponse'];
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

    // Validation ensures motivation is present (it's required in schema)
    if (!request.motivation) {
      throw new HTTPException(400, { message: 'motivation is required' });
    }

    // Build annotation object (includes W3C required @context and type)
    const annotation: Omit<Annotation, 'creator' | 'created'> = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id: annotationId,
      motivation: request.motivation,
      target: request.target,
      body: request.body as Annotation['body'],
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
        ...annotation,
        creator: userToAgent(user),
        created: new Date().toISOString(),
      },
    };

    return c.json(response, 201);
  }
);

/**
 * PUT /api/annotations/:id/body
 * Apply fine-grained operations to modify annotation body items
 * MUST come BEFORE GET to avoid {id} matching "/body"
 */
crudRouter.put('/api/annotations/:id/body',
  validateRequestBody('UpdateAnnotationBodyRequest'),
  async (c) => {
    const { id } = c.req.param();
    const request = c.get('validatedBody') as UpdateAnnotationBodyRequest;
    const user = c.get('user');

    console.log(`[BODY UPDATE HANDLER] Called for annotation ${id}, operations:`, request.operations);

    // Get annotation from Layer 3 (event store projection)
    const annotation = await AnnotationQueryService.getAnnotation(id, request.documentId);
    console.log(`[BODY UPDATE HANDLER] Layer 3 lookup result for ${id}:`, annotation ? 'FOUND' : 'NOT FOUND');

    if (!annotation) {
      console.log(`[BODY UPDATE HANDLER] Throwing 404 - annotation ${id} not found in Layer 3`);
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    // Emit annotation.body.updated event to Layer 2 (consumer will update Layer 3 projection)
    const eventStore = await getEventStore();
    await eventStore.appendEvent({
      type: 'annotation.body.updated',
      documentId: getTargetSource(annotation.target),
      userId: user.id,
      version: 1,
      payload: {
        annotationId: id,
        operations: request.operations as BodyOperation[],
      },
    });

    // Return optimistic response - Apply operations to body array
    const bodyArray = Array.isArray(annotation.body) ? [...annotation.body] : [];

    for (const op of request.operations) {
      if (op.op === 'add') {
        // Add item (idempotent - don't add if already exists)
        const exists = bodyArray.some(item =>
          JSON.stringify(item) === JSON.stringify(op.item)
        );
        if (!exists) {
          bodyArray.push(op.item);
        }
      } else if (op.op === 'remove') {
        // Remove item
        const index = bodyArray.findIndex(item =>
          JSON.stringify(item) === JSON.stringify(op.item)
        );
        if (index !== -1) {
          bodyArray.splice(index, 1);
        }
      } else if (op.op === 'replace') {
        // Replace item
        const index = bodyArray.findIndex(item =>
          JSON.stringify(item) === JSON.stringify(op.oldItem)
        );
        if (index !== -1) {
          bodyArray[index] = op.newItem;
        }
      }
    }

    const response: UpdateAnnotationBodyResponse = {
      annotation: {
        ...annotation,
        body: bodyArray,
      },
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

  // If it's a linking annotation with a resolved source, get resolved document
  let resolvedDocument = null;
  const bodySource = getBodySource(annotation.body);
  if (annotation.motivation === 'linking' && bodySource) {
    resolvedDocument = await DocumentQueryService.getDocumentMetadata(bodySource);
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
