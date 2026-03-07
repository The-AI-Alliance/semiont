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
import { AnnotationContext } from '@semiont/make-meaning';
import type { components } from '@semiont/core';
import { resourceId } from '@semiont/core';

type GetAnnotationsResponse = components['schemas']['GetAnnotationsResponse'];

export function registerGetResourceAnnotations(router: ResourcesRouterType) {
  /**
   * GET /resources/:id/annotations
   *
   * Get all annotations (both highlights and references) in a resource
   * Requires authentication
   * Uses view storage projections
   */
  router.get('/resources/:id/annotations', async (c) => {
    const { id } = c.req.param();
    const config = c.get('config');

    const annotations = await AnnotationContext.getAllAnnotations(resourceId(id), config);

    const response: GetAnnotationsResponse = {
      annotations,
      total: annotations.length
    };

    return c.json(response);
  });
}
