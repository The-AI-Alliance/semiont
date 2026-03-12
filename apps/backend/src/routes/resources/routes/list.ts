/**
 * List Resources Route
 *
 * Thin HTTP wrapper: emits browse:resources-requested on the EventBus,
 * awaits the Gatherer's response.
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { eventBusRequest } from '../../../utils/event-bus-request';

export function registerListResources(router: ResourcesRouterType) {
  router.get('/resources', async (c) => {
    const query = c.req.query();
    const eventBus = c.get('eventBus');
    const offset = Number(query.offset) || 0;
    const limit = Number(query.limit) || 50;
    const entityType = query.entityType;

    let archived: boolean | undefined;
    if (query.archived === 'true') {
      archived = true;
    } else if (query.archived === 'false') {
      archived = false;
    } else if (query.archived !== undefined) {
      throw new HTTPException(400, { message: 'Invalid value for archived parameter. Must be "true" or "false".' });
    }

    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'browse:resources-requested',
        { correlationId, search: query.q, archived, entityType, offset, limit },
        'browse:resources-result',
        'browse:resources-failed',
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
