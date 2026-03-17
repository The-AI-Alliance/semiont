/**
 * Referenced By Route
 *
 * Thin HTTP wrapper: emits bind:referenced-by-requested on the EventBus,
 * awaits the Matcher's response.
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { resourceId } from '@semiont/core';
import { eventBusRequest } from '../../../utils/event-bus-request';

export function registerGetReferencedBy(router: ResourcesRouterType) {
  router.get('/resources/:id/referenced-by', async (c) => {
    const { id } = c.req.param();
    const motivation = c.req.query('motivation');
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'bind:referenced-by-requested',
        { correlationId, resourceId: resourceId(id), motivation },
        'bind:referenced-by-result',
        'bind:referenced-by-failed',
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
