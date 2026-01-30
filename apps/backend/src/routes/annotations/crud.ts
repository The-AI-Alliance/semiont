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
import { type components } from '@semiont/api-client';
import { resourceId } from '@semiont/core';
import { validateRequestBody } from '../../middleware/validate-openapi';
import { AnnotationCrudService } from '../../services/annotation-crud-service';
import { AnnotationContext } from '@semiont/make-meaning';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];
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
    const { eventStore } = c.get('makeMeaning');
    const config = c.get('config');

    // Delegate to service for annotation creation
    try {
      const response = await AnnotationCrudService.createAnnotation(request, user, eventStore, config);
      return c.json(response, 201);
    } catch (error) {
      if (error instanceof Error && error.message === 'Backend publicURL not configured') {
        throw new HTTPException(500, { message: 'Failed to create annotation' });
      }
      if (error instanceof Error && error.message === 'TextPositionSelector required for creating annotations') {
        throw new HTTPException(400, { message: 'TextPositionSelector required for creating annotations' });
      }
      if (error instanceof Error && error.message === 'motivation is required') {
        throw new HTTPException(400, { message: 'motivation is required' });
      }
      throw error;
    }
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
    const { eventStore } = c.get('makeMeaning');
    const config = c.get('config');

    console.log(`[BODY UPDATE HANDLER] Called for annotation ${id}, operations:`, request.operations);

    // Delegate to service for body update
    try {
      const response = await AnnotationCrudService.updateAnnotationBody(id, request, user, eventStore, config);
      console.log(`[BODY UPDATE HANDLER] Successfully updated annotation ${id}`);
      return c.json(response);
    } catch (error) {
      if (error instanceof Error && error.message === 'Annotation not found') {
        console.log(`[BODY UPDATE HANDLER] Throwing 404 - annotation ${id} not found in view storage`);
        throw new HTTPException(404, { message: 'Annotation not found' });
      }
      throw error;
    }
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
  const projection = await AnnotationContext.getResourceAnnotations(resourceId(resourceIdParam), config);

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
    const { eventStore } = c.get('makeMeaning');
    const config = c.get('config');

    // Delegate to service for annotation deletion
    try {
      await AnnotationCrudService.deleteAnnotation(id, request.resourceId, user, eventStore, config);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof Error && error.message === 'Annotation not found in resource') {
        throw new HTTPException(404, { message: 'Annotation not found in resource' });
      }
      throw error;
    }
  }
);
