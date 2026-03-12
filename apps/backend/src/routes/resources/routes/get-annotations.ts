/**
 * Get Resource Annotations Route
 *
 * Thin HTTP wrapper: emits browse:annotations-requested on the EventBus,
 * awaits the Gatherer's response.
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { resourceId } from '@semiont/core';
import { eventBusRequest } from '../../../utils/event-bus-request';

export function registerGetResourceAnnotations(router: ResourcesRouterType) {
  router.get('/resources/:id/annotations', async (c) => {
    const { id } = c.req.param();
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'browse:annotations-requested',
        { correlationId, resourceId: resourceId(id) },
        'browse:annotations-result',
        'browse:annotations-failed',
      );
      return c.json(response);
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new HTTPException(504, { message: 'Request timed out' });
      }
      throw error;
    }
  });
}
