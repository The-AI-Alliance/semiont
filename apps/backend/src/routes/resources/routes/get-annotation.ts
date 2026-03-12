/**
 * Get Annotation Route
 *
 * Thin HTTP wrapper: emits browse:annotation-requested on the EventBus,
 * awaits the Gatherer's response.
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { resourceId, annotationId } from '@semiont/core';
import { eventBusRequest } from '../../../utils/event-bus-request';

export function registerGetAnnotation(router: ResourcesRouterType) {
  router.get('/resources/:resourceId/annotations/:annotationId', async (c) => {
    const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'browse:annotation-requested',
        { correlationId, resourceId: resourceId(resourceIdParam), annotationId: annotationId(annotationIdParam) },
        'browse:annotation-result',
        'browse:annotation-failed',
      );
      return c.json(response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Annotation not found') {
          throw new HTTPException(404, { message: 'Annotation not found' });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Request timed out' });
        }
      }
      throw error;
    }
  });
}
