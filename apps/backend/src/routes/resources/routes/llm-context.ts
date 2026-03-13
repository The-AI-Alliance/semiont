/**
 * Resource LLM Context Route
 * GET /resources/{id}/llm-context
 *
 * Emits gather:resource-requested on the EventBus and awaits the Gatherer's response.
 */

import { HTTPException } from 'hono/http-exception';
import { firstValueFrom, merge } from 'rxjs';
import { filter, map, take, timeout } from 'rxjs/operators';
import { resourceId } from '@semiont/core';
import type { ResourcesRouterType } from '../shared';

export function registerGetResourceLLMContext(router: ResourcesRouterType) {
  router.get('/resources/:id/llm-context', async (c) => {
    const { id } = c.req.param();
    const query = c.req.query();
    const eventBus = c.get('eventBus');

    // Parse and validate query parameters
    const depth = query.depth ? Number(query.depth) : 2;
    const maxResources = query.maxResources ? Number(query.maxResources) : 10;
    const includeContent = query.includeContent === 'false' ? false : true;
    const includeSummary = query.includeSummary === 'true' ? true : false;

    if (depth < 1 || depth > 3) {
      throw new HTTPException(400, { message: 'Query parameter "depth" must be between 1 and 3' });
    }

    if (maxResources < 1 || maxResources > 20) {
      throw new HTTPException(400, { message: 'Query parameter "maxResources" must be between 1 and 20' });
    }

    // Emit gather:resource-requested — Gatherer subscribes and calls LLMContext.getResourceContext
    eventBus.get('gather:resource-requested').next({
      resourceId: resourceId(id),
      options: { depth, maxResources, includeContent, includeSummary },
    });

    try {
      const result = await firstValueFrom(
        merge(
          eventBus.get('gather:resource-complete').pipe(
            filter(e => e.resourceId === id),
            map(e => ({ ok: true as const, context: e.context })),
          ),
          eventBus.get('gather:resource-failed').pipe(
            filter(e => e.resourceId === id),
            map(e => ({ ok: false as const, error: e.error })),
          ),
        ).pipe(take(1), timeout(30_000)),
      );

      if (!result.ok) {
        throw result.error;
      }

      return c.json(result.context);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Resource not found') {
          throw new HTTPException(404, { message: 'Resource not found' });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Context gathering timed out' });
        }
      }
      throw error;
    }
  });
}
