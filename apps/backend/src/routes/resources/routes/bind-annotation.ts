/**
 * Bind Annotation Route
 *
 * POST /resources/:resourceId/annotations/:annotationId/bind
 *
 * Applies annotation body operations (add/remove/replace SpecificResource
 * links). Returns {correlationId} immediately; the actual state change
 * arrives on the long-lived events-stream as an enriched mark:body-updated
 * event carrying the full post-materialization annotation.
 *
 * This is the load-bearing contract for the link icon flip: the events-stream
 * enrichment step (event-stream-enrichment.ts) reads the annotation from
 * the materialized view and includes it on the SSE wire format. The
 * AnnotationStore writes it in-place — no refetch, no dependency on a
 * per-operation stream. See .plans/BINDING.md and .plans/UNIFIED-STREAM.md.
 *
 * Replaces the former bind-annotation-stream SSE route.
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { BodyOperation } from '@semiont/core';
import { resourceId, annotationId, userId, userToDid } from '@semiont/core';
import { getLogger } from '../../../logger';
import type { components } from '@semiont/core';

type BindAnnotationStreamRequest = components['schemas']['BindAnnotationStreamRequest'];

export function registerBindAnnotation(router: ResourcesRouterType) {
  router.post('/resources/:resourceId/annotations/:annotationId/bind',
    validateRequestBody('BindAnnotationStreamRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const request = c.get('validatedBody') as BindAnnotationStreamRequest;
      const user = c.get('user');

      if (!user) {
        throw new HTTPException(401, { message: 'Authentication required' });
      }

      const eventBus = c.get('eventBus');
      const correlationId = crypto.randomUUID();

      const logger = getLogger().child({
        component: 'bind-annotation',
        resourceId: resourceIdParam,
        annotationId: annotationIdParam,
        correlationId,
      });

      logger.info('Bind requested', { operationCount: request.operations.length });

      // Emit the update-body command on the core EventBus with the
      // correlationId so the Stower threads it into event metadata.
      // Flow: Stower → appendEvent({..}, {correlationId}) → materialize view
      // → publish StoredEvent on scoped bus → events-stream delivers the
      // enriched event to all connected clients.
      eventBus.get('mark:update-body').next({
        correlationId,
        annotationId: annotationId(annotationIdParam),
        resourceId: resourceId(resourceIdParam),
        userId: userId(userToDid(user)),
        operations: request.operations as BodyOperation[],
      });

      logger.info('Emitted mark:update-body');

      return c.json({ correlationId }, 202);
    }
  );
}
