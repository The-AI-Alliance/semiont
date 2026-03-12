/**
 * Annotation History Route
 *
 * Thin HTTP wrapper: emits browse:annotation-history-requested on the EventBus,
 * awaits the Gatherer's response.
 */

import { HTTPException } from 'hono/http-exception';
import type { AnnotationsRouterType } from '../shared';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { eventBusRequest } from '../../../utils/event-bus-request';

export function registerGetAnnotationHistory(router: AnnotationsRouterType) {
  router.get('/resources/:resourceId/annotations/:annotationId/history', async (c) => {
    const { resourceId, annotationId } = c.req.param();
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'browse:annotation-history-requested',
        { correlationId, resourceId: makeResourceId(resourceId), annotationId: makeAnnotationId(annotationId) },
        'browse:annotation-history-result',
        'browse:annotation-history-failed',
      );
      return c.json(response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Annotation not found') {
          throw new HTTPException(404, { message: 'Annotation not found' });
        }
        if (error.message === 'Annotation does not belong to this resource') {
          throw new HTTPException(404, { message: 'Annotation does not belong to this resource' });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Request timed out' });
        }
      }
      throw error;
    }
  });
}
