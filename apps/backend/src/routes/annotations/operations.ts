/**
 * Annotation Operations Routes - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request bodies with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { createAnnotationRouter, type AnnotationsRouterType } from './shared';
import { annotationId, resourceId as makeResourceId } from '@semiont/core';
import { AnnotationOperations } from '../../services/annotation-operations';

// Create router with auth middleware
export const operationsRouter: AnnotationsRouterType = createAnnotationRouter();

/**
 * GET /api/annotations/:id/context
 *
 * Get the context around an annotation
 * Requires authentication
 *
 * Query parameters:
 * - contextBefore: Characters before selection (0-5000, default: 100)
 * - contextAfter: Characters after selection (0-5000, default: 100)
 */
operationsRouter.get('/api/annotations/:id/context', async (c) => {
  const { id } = c.req.param();
  const query = c.req.query();
  const config = c.get('config');

  // Require resourceId query parameter
  const resourceId = query.resourceId;
  if (!resourceId) {
    throw new HTTPException(400, { message: 'resourceId query parameter is required' });
  }

  // Parse and validate query parameters
  const contextBefore = query.contextBefore ? Number(query.contextBefore) : 100;
  const contextAfter = query.contextAfter ? Number(query.contextAfter) : 100;

  // Validate ranges
  if (contextBefore < 0 || contextBefore > 5000) {
    throw new HTTPException(400, { message: 'Query parameter "contextBefore" must be between 0 and 5000' });
  }
  if (contextAfter < 0 || contextAfter > 5000) {
    throw new HTTPException(400, { message: 'Query parameter "contextAfter" must be between 0 and 5000' });
  }

  // Delegate to service for annotation context extraction
  try {
    const response = await AnnotationOperations.getAnnotationContext(
      annotationId(id),
      makeResourceId(resourceId),
      contextBefore,
      contextAfter,
      config
    );

    return c.json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Annotation not found') {
      throw new HTTPException(404, { message: 'Annotation not found' });
    }
    if (error instanceof Error && error.message === 'Resource not found') {
      throw new HTTPException(404, { message: 'Resource not found' });
    }
    if (error instanceof Error && error.message === 'Resource content not found') {
      throw new HTTPException(404, { message: 'Resource content not found' });
    }
    if (error instanceof Error && error.message === 'TextPositionSelector required for context') {
      throw new HTTPException(400, { message: 'TextPositionSelector required for context' });
    }
    throw error;
  }
});

/**
 * GET /api/annotations/:id/summary
 *
 * Get an AI-generated summary of the annotation in context
 * Requires authentication
 */
operationsRouter.get('/api/annotations/:id/summary', async (c) => {
  const { id } = c.req.param();
  const query = c.req.query();
  const config = c.get('config');

  // Require resourceId query parameter
  const resourceId = query.resourceId;
  if (!resourceId) {
    throw new HTTPException(400, { message: 'resourceId query parameter is required' });
  }

  // Delegate to service for annotation summary generation
  try {
    const response = await AnnotationOperations.generateAnnotationSummary(
      annotationId(id),
      makeResourceId(resourceId),
      config
    );

    return c.json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Annotation not found') {
      throw new HTTPException(404, { message: 'Annotation not found' });
    }
    if (error instanceof Error && error.message === 'Resource not found') {
      throw new HTTPException(404, { message: 'Resource not found' });
    }
    if (error instanceof Error && error.message === 'Resource content not found') {
      throw new HTTPException(404, { message: 'Resource content not found' });
    }
    throw error;
  }
});
