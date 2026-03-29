/**
 * Create Annotation Route
 * POST /resources/{id}/annotations
 *
 * Validates the request, assembles the W3C annotation, emits mark:create
 * on the EventBus, and returns 202 Accepted. The frontend receives the
 * persisted annotation via the SSE events-stream (annotation.added).
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/core';
import { resourceId, userId, userToDid, userToAgent } from '@semiont/core';
import { assembleAnnotation } from '@semiont/core';
import { validateRequestBody } from '../../../middleware/validate-openapi';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];

export function registerCreateAnnotation(router: ResourcesRouterType) {
  router.post('/resources/:id/annotations',
    validateRequestBody('CreateAnnotationRequest'),
    async (c) => {
      const { id } = c.req.param();
      const request = c.get('validatedBody') as CreateAnnotationRequest;
      const user = c.get('user');

      // Assemble W3C annotation (validates selectors, generates bare ID)
      let annotation;
      try {
        ({ annotation } = assembleAnnotation(request, userToAgent(user)));
      } catch (error) {
        if (error instanceof Error) {
          throw new HTTPException(400, { message: error.message });
        }
        throw error;
      }

      // Emit mark:create — Stower subscribes and persists
      const eventBus = c.get('eventBus');
      eventBus.get('mark:create').next({
        annotation,
        userId: userId(userToDid(user)),
        resourceId: resourceId(id),
      });

      return c.json({ annotationId: annotation.id }, 202);
    }
  );
}
