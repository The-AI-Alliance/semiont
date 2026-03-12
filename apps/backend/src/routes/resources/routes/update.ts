/**
 * Update Resource Route
 *
 * Thin 202-emitter: validates request, emits events via ResourceOperations,
 * returns 202 Accepted. Frontend reconciles state via SSE domain events
 * (resource.archived, resource.unarchived, entitytag.added, entitytag.removed).
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { ResourceContext, ResourceOperations } from '@semiont/make-meaning';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { userId, resourceId } from '@semiont/core';

type UpdateResourceRequest = components['schemas']['UpdateResourceRequest'];

export function registerUpdateResource(router: ResourcesRouterType) {
  router.patch('/resources/:id',
    validateRequestBody('UpdateResourceRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as UpdateResourceRequest;
      const user = c.get('user');
      const eventBus = c.get('eventBus');
      const { kb } = c.get('makeMeaning');

      // Check resource exists using view storage
      const doc = await ResourceContext.getResourceMetadata(resourceId(id), kb);
      if (!doc) {
        throw new HTTPException(404, { message: 'Resource not found' });
      }

      // Delegate to make-meaning service — emits mark:archive/unarchive/update-entity-types
      await ResourceOperations.updateResource(
        {
          resourceId: resourceId(id),
          userId: userId(user.id),
          currentArchived: doc.archived,
          updatedArchived: body.archived,
          currentEntityTypes: doc.entityTypes,
          updatedEntityTypes: body.entityTypes,
        },
        eventBus,
      );

      return c.body(null, 202);
    }
  );
}
