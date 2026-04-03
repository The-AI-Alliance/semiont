/**
 * Get Annotation URI Route
 *
 * Returns JSON-LD representation of an annotation.
 * Requires resourceId query parameter for O(1) view storage lookup.
 */

import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import type { components } from '@semiont/core';
import { getBodySource } from '@semiont/api-client';
import { AnnotationContext } from '@semiont/make-meaning';
import { ResourceContext } from '@semiont/make-meaning';
import { resourceId as makeResourceId } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];
type GetAnnotationResponse = components['schemas']['GetAnnotationResponse'];

export function registerGetAnnotationUri(router: AnnotationsRouterType) {
  router.get('/annotations/:id', async (c) => {
    const { id } = c.req.param();
    const query = c.req.query();
    const { knowledgeSystem: { kb } } = c.get('makeMeaning');
    const resourceIdParam = query.resourceId;

    if (!resourceIdParam) {
      throw new HTTPException(400, { message: 'resourceId query parameter is required' });
    }

    // O(1) lookup in view storage using resource ID
    const projection = await AnnotationContext.getResourceAnnotations(makeResourceId(resourceIdParam), kb);

    // Find the annotation
    const annotation = projection.annotations.find((a: Annotation) => a.id === id);

    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found in resource' });
    }

    // Get resource metadata
    const resource = await ResourceContext.getResourceMetadata(makeResourceId(resourceIdParam), kb);

    // If it's a linking annotation with a resolved source, get resolved resource
    let resolvedResource = null;
    const bodySource = getBodySource(annotation.body);
    if (annotation.motivation === 'linking' && bodySource) {
      resolvedResource = await ResourceContext.getResourceMetadata(makeResourceId(bodySource), kb);
    }

    const response: GetAnnotationResponse = {
      annotation,
      resource,
      resolvedResource,
    };

    c.header('Content-Type', 'application/ld+json; charset=utf-8');
    return c.json(response);
  });
}
