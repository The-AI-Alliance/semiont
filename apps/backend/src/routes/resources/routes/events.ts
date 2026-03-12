/**
 * Resource Events Route
 *
 * Thin HTTP wrapper: emits browse:events-requested on the EventBus,
 * awaits the Gatherer's response.
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { resourceId } from '@semiont/core';
import { eventBusRequest } from '../../../utils/event-bus-request';

const eventTypes = [
  'resource.created',
  'resource.cloned',
  'resource.archived',
  'resource.unarchived',
  'annotation.added',
  'annotation.removed',
  'annotation.body.updated',
  'entitytag.added',
  'entitytag.removed',
] as const;

function isValidEventType(type: string): type is typeof eventTypes[number] {
  return eventTypes.includes(type as any);
}

export function registerGetEvents(router: ResourcesRouterType) {
  router.get('/resources/:id/events', async (c) => {
    const { id } = c.req.param();
    const queryParams = c.req.query();
    const eventBus = c.get('eventBus');

    const type = queryParams.type;
    const userId = queryParams.userId;
    const limit = queryParams.limit ? Number(queryParams.limit) : 100;

    if (type && !isValidEventType(type)) {
      throw new HTTPException(400, { message: `Invalid event type. Must be one of: ${eventTypes.join(', ')}` });
    }

    if (limit < 1 || limit > 1000) {
      throw new HTTPException(400, { message: 'Query parameter "limit" must be between 1 and 1000' });
    }

    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'browse:events-requested',
        { correlationId, resourceId: resourceId(id), type, userId, limit },
        'browse:events-result',
        'browse:events-failed',
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
