/**
 * Get Annotation Route
 * GET /resources/{resourceId}/annotations/{annotationId}
 *
 * Gets a specific annotation from a resource using nested path format
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { getBodySource } from '@semiont/api-client';
import { resourceId as makeResourceId, annotationId } from '@semiont/core';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { ResourceQueryService } from '../../../services/resource-queries';

type GetAnnotationResponse = components['schemas']['GetAnnotationResponse'];

export function registerGetAnnotation(router: ResourcesRouterType) {
  /**
   * GET /resources/:resourceId/annotations/:annotationId
   * Get a specific annotation from a resource
   */
  router.get('/resources/:resourceId/annotations/:annotationId', async (c) => {
    const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
    const config = c.get('config');

    // Get annotation from view storage
    const annotation = await AnnotationQueryService.getAnnotation(
      annotationId(annotationIdParam),
      makeResourceId(resourceIdParam),
      config
    );

    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    // Get source resource metadata
    const resource = await ResourceQueryService.getResourceMetadata(
      makeResourceId(resourceIdParam),
      config
    );

    // Get resolved resource if annotation body contains a link
    let resolvedResource = null;
    const bodySource = getBodySource(annotation.body);
    if (bodySource) {
      const resolvedId = bodySource.split('/').pop()!;
      resolvedResource = await ResourceQueryService.getResourceMetadata(
        makeResourceId(resolvedId),
        config
      );
    }

    const response: GetAnnotationResponse = {
      annotation,
      resource,
      resolvedResource,
    };

    return c.json(response);
  });
}
