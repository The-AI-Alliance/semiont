/**
 * Delete Annotation Route
 * DELETE /resources/{resourceId}/annotations/{annotationId}
 *
 * Emits mark:delete on the EventBus and returns 202 Accepted.
 * The frontend receives confirmation via the SSE events-stream (annotation.removed).
 */

import type { ResourcesRouterType } from '../shared';
import { resourceId, annotationId, userId } from '@semiont/core';

export function registerDeleteAnnotation(router: ResourcesRouterType) {
  router.delete('/resources/:resourceId/annotations/:annotationId', async (c) => {
    const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
    const user = c.get('user');
    const eventBus = c.get('eventBus');

    eventBus.get('mark:delete').next({
      annotationId: annotationId(annotationIdParam),
      userId: userId(user.id),
      resourceId: resourceId(resourceIdParam),
    });

    return c.body(null, 202);
  });
}
