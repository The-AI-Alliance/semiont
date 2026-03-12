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
import { resourceId, userId, userToAgent } from '@semiont/core';
import { assembleAnnotation } from '@semiont/make-meaning';
import { validateRequestBody } from '../../../middleware/validate-openapi';

type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];

export function registerCreateAnnotation(router: ResourcesRouterType) {
  router.post('/resources/:id/annotations',
    validateRequestBody('CreateAnnotationRequest'),
    async (c) => {
      const { id } = c.req.param();
      const request = c.get('validatedBody') as CreateAnnotationRequest;
      const user = c.get('user');
      const config = c.get('config');

      const backendUrl = config.services.backend?.publicURL;
      if (!backendUrl) {
        throw new HTTPException(500, { message: 'Backend publicURL not configured' });
      }

      // Assemble W3C annotation (validates selectors, generates ID)
      let annotation;
      let bodyArray;
      try {
        ({ annotation, bodyArray } = assembleAnnotation(request, userToAgent(user), backendUrl));
      } catch (error) {
        if (error instanceof Error) {
          throw new HTTPException(400, { message: error.message });
        }
        throw error;
      }

      // Emit mark:create — Stower subscribes and persists
      const eventBus = c.get('eventBus');
      eventBus.get('mark:create').next({
        motivation: annotation.motivation,
        selector: request.target.selector,
        body: bodyArray,
        userId: userId(user.id),
        resourceId: resourceId(id),
        annotation,
      });

      return c.json({ annotationId: annotation.id }, 202);
    }
  );
}
