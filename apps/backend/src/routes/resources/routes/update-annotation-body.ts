/**
 * Update Annotation Body Route
 * PUT /resources/{resourceId}/annotations/{annotationId}/body
 *
 * Updates annotation body using fine-grained operations
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/core';
import type { BodyOperation } from '@semiont/core';
import { resourceId, annotationId, userId } from '@semiont/core';
import { AnnotationContext } from '@semiont/make-meaning';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import { getLogger } from '../../../logger';

const logger = getLogger().child({ component: 'update-annotation-body' });

type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];
type UpdateAnnotationBodyResponse = components['schemas']['UpdateAnnotationBodyResponse'];

export function registerUpdateAnnotationBody(router: ResourcesRouterType) {
  /**
   * PUT /resources/:resourceId/annotations/:annotationId/body
   * Apply fine-grained operations to modify annotation body items
   */
  router.put('/resources/:resourceId/annotations/:annotationId/body',
    validateRequestBody('UpdateAnnotationBodyRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const request = c.get('validatedBody') as UpdateAnnotationBodyRequest;
      const user = c.get('user');
      const config = c.get('config');

      logger.debug('Body update handler called', {
        annotationId: annotationIdParam,
        operations: request.operations
      });

      // Get annotation from view storage
      const annotation = await AnnotationContext.getAnnotation(
        annotationId(annotationIdParam),
        resourceId(resourceIdParam),
        config
      );
      logger.debug('View storage lookup result', {
        annotationId: annotationIdParam,
        found: !!annotation
      });

      if (!annotation) {
        logger.warn('Annotation not found in view storage', {
          annotationId: annotationIdParam,
          resourceId: resourceIdParam
        });
        throw new HTTPException(404, { message: 'Annotation not found' });
      }

      // Emit annotation.body.updated event
      const { eventStore } = c.get('makeMeaning');
      await eventStore.appendEvent({
        type: 'annotation.body.updated',
        resourceId: resourceId(resourceIdParam),
        userId: userId(user.id),
        version: 1,
        payload: {
          annotationId: annotationId(annotationIdParam),
          operations: request.operations as BodyOperation[],
        },
      });

      // Return optimistic response - Apply operations to body array
      const bodyArray = Array.isArray(annotation.body) ? [...annotation.body] : [];

      for (const op of request.operations) {
        if (op.op === 'add') {
          // Add item (idempotent - don't add if already exists)
          const exists = bodyArray.some(item =>
            JSON.stringify(item) === JSON.stringify(op.item)
          );
          if (!exists) {
            bodyArray.push(op.item);
          }
        } else if (op.op === 'remove') {
          // Remove item
          const index = bodyArray.findIndex(item =>
            JSON.stringify(item) === JSON.stringify(op.item)
          );
          if (index !== -1) {
            bodyArray.splice(index, 1);
          }
        } else if (op.op === 'replace') {
          // Replace item
          const index = bodyArray.findIndex(item =>
            JSON.stringify(item) === JSON.stringify(op.oldItem)
          );
          if (index !== -1) {
            bodyArray[index] = op.newItem;
          }
        }
      }

      const response: UpdateAnnotationBodyResponse = {
        annotation: {
          ...annotation,
          body: bodyArray,
        },
      };

      return c.json(response);
    }
  );
}
