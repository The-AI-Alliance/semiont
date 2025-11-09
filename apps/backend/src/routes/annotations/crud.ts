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
 * - GET /api/annotations (list)
 * - DELETE /api/annotations/:id (delete)
 */

import { HTTPException } from 'hono/http-exception';
import { createAnnotationRouter, type AnnotationsRouterType } from './shared';
import { createEventStore } from '../../services/event-store-service';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector } from '@semiont/api-client';
import type {
  AnnotationAddedEvent,
  BodyOperation,
} from '@semiont/core';
import { resourceId, annotationId, userId } from '@semiont/core';
import { getTargetSource } from '../../lib/annotation-utils';
import { generateAnnotationId, userToAgent } from '../../utils/id-generator';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { uriToResourceId } from '../../lib/uri-utils';
import { validateRequestBody } from '../../middleware/validate-openapi';

type Annotation = components['schemas']['Annotation'];

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type CreateAnnotationResponse = components['schemas']['CreateAnnotationResponse'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];
type UpdateAnnotationBodyResponse = components['schemas']['UpdateAnnotationBodyResponse'];
type DeleteAnnotationRequest = components['schemas']['DeleteAnnotationRequest'];
type ListAnnotationsResponse = components['schemas']['ListAnnotationsResponse'];

// Create router with auth middleware
export const crudRouter: AnnotationsRouterType = createAnnotationRouter();

/**
 * POST /api/annotations
 * Create a new annotation/reference in a resource
 */
crudRouter.post('/api/annotations',
  validateRequestBody('CreateAnnotationRequest'),
  async (c) => {
    const request = c.get('validatedBody') as CreateAnnotationRequest;
    const user = c.get('user');
    const config = c.get('config');

    // Generate ID - backend-internal, not graph-dependent
    let newAnnotationId: string;
    try {
      const backendUrl = config.services.backend?.publicURL;
      if (!backendUrl) {
        throw new Error('Backend publicURL not configured');
      }
      newAnnotationId = generateAnnotationId(backendUrl);
    } catch (error) {
      console.error('Failed to generate annotation ID:', error);
      throw new HTTPException(500, { message: 'Failed to create annotation' });
    }
    // Extract TextPositionSelector (required for creating annotations)
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
      id: newAnnotationId,
      motivation: request.motivation,
      target: request.target,
      body: request.body as Annotation['body'],
      modified: new Date().toISOString(),
    };

    // Emit unified annotation.added event (single source of truth)
    const eventStore = await createEventStore( config);
    const eventPayload: Omit<AnnotationAddedEvent, 'id' | 'timestamp'> = {
      type: 'annotation.added',
      resourceId: uriToResourceId(request.target.source), // Extract ID from URI for indexing
      userId: userId(user.id),
      version: 1,
      payload: {
        annotation, // Annotation contains full URIs in target.source
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
    const config = c.get('config');

    console.log(`[BODY UPDATE HANDLER] Called for annotation ${id}, operations:`, request.operations);

    // Get annotation from view storage (event store projection)
    const annotation = await AnnotationQueryService.getAnnotation(annotationId(id), resourceId(request.resourceId), config);
    console.log(`[BODY UPDATE HANDLER] view storage lookup result for ${id}:`, annotation ? 'FOUND' : 'NOT FOUND');

    if (!annotation) {
      console.log(`[BODY UPDATE HANDLER] Throwing 404 - annotation ${id} not found in view storage`);
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    // Emit annotation.body.updated event to Event Store (consumer will update view storage projection)
    const eventStore = await createEventStore( config);
    await eventStore.appendEvent({
      type: 'annotation.body.updated',
      resourceId: uriToResourceId(getTargetSource(annotation.target)), // Extract ID from URI
      userId: userId(user.id),
      version: 1,
      payload: {
        annotationId: annotationId(id),
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
 * GET /api/annotations
 * List all annotations for a resource (requires resourceId for O(1) view storage lookup)
 */
crudRouter.get('/api/annotations', async (c) => {
  const query = c.req.query();
  const resourceIdParam = query.resourceId;
  const offset = Number(query.offset) || 0;
  const limit = Number(query.limit) || 50;
  const config = c.get('config');

  if (!resourceIdParam) {
    throw new HTTPException(400, { message: 'resourceId query parameter is required' });
  }

  // O(1) lookup in view storage using resource ID
  const projection = await AnnotationQueryService.getResourceAnnotations(resourceId(resourceIdParam), config);

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
 * Delete an annotation (requires resourceId in body for O(1) view storage lookup)
 */
crudRouter.delete('/api/annotations/:id',
  validateRequestBody('DeleteAnnotationRequest'),
  async (c) => {
    const { id } = c.req.param();
    const request = c.get('validatedBody') as DeleteAnnotationRequest;
    const user = c.get('user');
    const config = c.get('config');

    // O(1) lookup in view storage using resource ID (extract from URI)
    const resourceId = uriToResourceId(request.resourceId);
    const projection = await AnnotationQueryService.getResourceAnnotations(resourceId, config);

    // Find the annotation in this resource's annotations
    const annotation = projection.annotations.find((a: Annotation) => a.id === id);

    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found in resource' });
    }

    // Emit unified annotation.removed event (consumer will delete from GraphDB and update view storage)
    const eventStore = await createEventStore( config);
    console.log('[DeleteAnnotation] Emitting annotation.removed event for:', id);
    const storedEvent = await eventStore.appendEvent({
      type: 'annotation.removed',
      resourceId, // Use extracted short ID for event indexing
      userId: userId(user.id),
      version: 1,
      payload: {
        annotationId: annotationId(id),
      },
    });
    console.log('[DeleteAnnotation] Event emitted, sequence:', storedEvent.metadata.sequenceNumber);

    return c.body(null, 204);
  }
);
