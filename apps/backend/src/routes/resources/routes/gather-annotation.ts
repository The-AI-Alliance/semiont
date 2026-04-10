/**
 * Gather Annotation Context Route
 *
 * POST /resources/:resourceId/annotations/:annotationId/gather
 *
 * Submits a gather-context command. Returns {correlationId} immediately.
 * The Gatherer actor assembles passage + graph context (long-running, involves
 * LLM calls and graph traversal) and publishes results on the resource-scoped
 * EventBus. Results reach the client via the long-lived events-stream as
 * gather:complete, gather:failed, or gather:annotation-progress events.
 *
 * Replaces the former gather-annotation-stream SSE route.
 * See .plans/UNIFIED-STREAM.md.
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { annotationId, resourceId } from '@semiont/core';
import { getLogger } from '../../../logger';

type GatherAnnotationStreamRequest = components['schemas']['GatherAnnotationStreamRequest'];

export function registerGatherAnnotation(router: ResourcesRouterType) {
  router.post(
    '/resources/:resourceId/annotations/:annotationId/gather',
    validateRequestBody('GatherAnnotationStreamRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const body = c.get('validatedBody') as GatherAnnotationStreamRequest;
      const contextWindow = body.contextWindow ?? 1000;
      const eventBus = c.get('eventBus');
      const logger = getLogger().child({
        component: 'gather-annotation',
        resourceId: resourceIdParam,
        annotationId: annotationIdParam,
      });

      const user = c.get('user');
      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const correlationId = body.correlationId ?? crypto.randomUUID();

      logger.info('Gather annotation context requested', {
        annotationId: annotationIdParam,
        correlationId,
        contextWindow,
      });

      // Emit the gather command. The Gatherer handles it asynchronously
      // (LLM calls + graph traversal) and publishes results on
      // eventBus.scope(resourceId). The events-stream delivers them to
      // all connected clients.
      eventBus.get('gather:requested').next({
        correlationId,
        annotationId: annotationId(annotationIdParam),
        resourceId: resourceId(resourceIdParam),
        options: { includeSourceContext: true, includeTargetContext: true, contextWindow },
      });

      return c.json({ correlationId }, 202);
    }
  );
}
