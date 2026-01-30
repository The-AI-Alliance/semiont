/**
 * Delete Annotation Route
 * DELETE /resources/{resourceId}/annotations/{annotationId}
 *
 * Deletes an annotation using nested path format
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { annotationUri } from '@semiont/api-client';
import { resourceId, annotationId, userId } from '@semiont/core';
import { AnnotationContext } from '@semiont/make-meaning';

type Annotation = components['schemas']['Annotation'];

export function registerDeleteAnnotation(router: ResourcesRouterType) {
  /**
   * DELETE /resources/:resourceId/annotations/:annotationId
   * Delete an annotation
   */
  router.delete('/resources/:resourceId/annotations/:annotationId', async (c) => {
    const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
    const user = c.get('user');
    const config = c.get('config');

    // Get projection to verify annotation exists
    const projection = await AnnotationContext.getResourceAnnotations(
      resourceId(resourceIdParam),
      config
    );

    // Find the annotation in this resource's annotations
    // Annotation IDs in the projection are full URIs, so construct the full URI for comparison
    const fullAnnotationUri = annotationUri(`${config.services.backend!.publicURL}/annotations/${annotationIdParam}`);
    const annotation = projection.annotations.find(
      (a: Annotation) => a.id === fullAnnotationUri
    );

    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found in resource' });
    }

    // Emit unified annotation.removed event
    const { eventStore } = c.get('makeMeaning');
    console.log('[DeleteAnnotation] Emitting annotation.removed event for:', annotationIdParam);
    const storedEvent = await eventStore.appendEvent({
      type: 'annotation.removed',
      resourceId: resourceId(resourceIdParam),
      userId: userId(user.id),
      version: 1,
      payload: {
        annotationId: annotationId(annotationIdParam),
      },
    });
    console.log('[DeleteAnnotation] Event emitted, sequence:', storedEvent.metadata.sequenceNumber);

    return c.body(null, 204);
  });
}
