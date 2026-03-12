/**
 * Update Annotation Body Route
 * PUT /resources/{resourceId}/annotations/{annotationId}/body
 *
 * Emits mark:update-body on the EventBus and returns 202 Accepted.
 * The frontend receives the updated annotation via the SSE events-stream
 * (annotation.body.updated).
 */

import type { ResourcesRouterType } from '../shared';
import type { BodyOperation } from '@semiont/core';
import { resourceId, annotationId, userId } from '@semiont/core';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';

type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];

export function registerUpdateAnnotationBody(router: ResourcesRouterType) {
  router.put('/resources/:resourceId/annotations/:annotationId/body',
    validateRequestBody('UpdateAnnotationBodyRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const request = c.get('validatedBody') as UpdateAnnotationBodyRequest;
      const user = c.get('user');
      const eventBus = c.get('eventBus');

      eventBus.get('mark:update-body').next({
        annotationId: annotationId(annotationIdParam),
        resourceId: resourceId(resourceIdParam),
        userId: userId(user.id),
        operations: request.operations as BodyOperation[],
      });

      return c.body(null, 202);
    }
  );
}
