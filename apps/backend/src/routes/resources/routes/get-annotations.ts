/**
 * Get Resource Annotations Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No request body validation needed (GET route with only path params)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import type { ResourcesRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import type { components } from '@semiont/api-client';
import { resourceId } from '@semiont/core';

type GetAnnotationsResponse = components['schemas']['GetAnnotationsResponse'];

export function registerGetResourceAnnotations(router: ResourcesRouterType) {
  /**
   * GET /api/resources/:id/annotations
   *
   * Get all annotations (both highlights and references) in a resource
   * Requires authentication
   * Uses Layer 3 projections
   */
  router.get('/api/resources/:id/annotations', async (c) => {
    const { id } = c.req.param();
    const config = c.get('config');

    const annotations = await AnnotationQueryService.getAllAnnotations(resourceId(id), config);

    const response: GetAnnotationsResponse = {
      annotations,
      total: annotations.length
    };

    return c.json(response);
  });
}
