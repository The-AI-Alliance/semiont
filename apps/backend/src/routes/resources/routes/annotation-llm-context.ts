/**
 * Annotation LLM Context Route
 * GET /resources/{resourceId}/annotations/{annotationId}/llm-context
 *
 * Emits gather:requested on the EventBus and awaits the Gatherer's response.
 */

import { HTTPException } from 'hono/http-exception';
import { firstValueFrom, merge } from 'rxjs';
import { filter, map, take, timeout } from 'rxjs/operators';
import type { ResourcesRouterType } from '../shared';

export function registerGetAnnotationLLMContext(router: ResourcesRouterType) {
  router.get('/resources/:resourceId/annotations/:annotationId/llm-context', async (c) => {
    const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
    const query = c.req.query();
    const eventBus = c.get('eventBus');

    // Parse and validate query parameters
    const includeSourceContext = query.includeSourceContext === 'false' ? false : true;
    const includeTargetContext = query.includeTargetContext === 'false' ? false : true;
    const contextWindow = query.contextWindow ? Number(query.contextWindow) : 1000;

    if (contextWindow < 100 || contextWindow > 5000) {
      throw new HTTPException(400, { message: 'Query parameter "contextWindow" must be between 100 and 5000' });
    }

    // Emit gather:requested — Gatherer subscribes and calls AnnotationContext.buildLLMContext
    eventBus.get('gather:requested').next({
      annotationId: annotationIdParam,
      resourceId: resourceIdParam,
      options: { includeSourceContext, includeTargetContext, contextWindow },
    });

    try {
      const result = await firstValueFrom(
        merge(
          eventBus.get('gather:complete').pipe(
            filter(e => e.annotationId === annotationIdParam),
            map(e => ({ ok: true as const, response: e.response })),
          ),
          eventBus.get('gather:failed').pipe(
            filter(e => e.annotationId === annotationIdParam),
            map(e => ({ ok: false as const, error: e.error })),
          ),
        ).pipe(take(1), timeout(30_000)),
      );

      if (!result.ok) {
        throw result.error;
      }

      return c.json(result.response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Annotation not found') {
          throw new HTTPException(404, { message: 'Annotation not found' });
        }
        if (error.message === 'Source resource not found') {
          throw new HTTPException(404, { message: 'Source resource not found' });
        }
        if (error.message === 'Source content not found') {
          throw new HTTPException(404, { message: 'Source content not found' });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Context gathering timed out' });
        }
      }
      throw error;
    }
  });
}
