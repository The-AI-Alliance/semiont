/**
 * Delete Annotation Route
 * DELETE /resources/{resourceId}/annotations/{annotationId}
 *
 * Deletes an annotation using nested path format
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { createEventStore } from '../../../services/event-store-service';
import type { components } from '@semiont/api-client';
import { resourceId, annotationId, userId } from '@semiont/core';
import { AnnotationQueryService } from '../../../services/annotation-queries';

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
    const projection = await AnnotationQueryService.getResourceAnnotations(
      resourceId(resourceIdParam),
      config
    );

    // Find the annotation in this resource's annotations
    const annotation = projection.annotations.find(
      (a: Annotation) => a.id === annotationIdParam
    );

    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found in resource' });
    }

    // Emit unified annotation.removed event
    const eventStore = await createEventStore(config);
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
