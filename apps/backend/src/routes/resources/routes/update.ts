/**
 * Update Resource Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { createEventStore } from '../../../services/event-store-service';
import { ResourceQueryService } from '../../../services/resource-queries';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/api-client';
import { userId, resourceId } from '@semiont/core';

type UpdateResourceRequest = components['schemas']['UpdateResourceRequest'];
type GetResourceResponse = components['schemas']['GetResourceResponse'];

export function registerUpdateResource(router: ResourcesRouterType) {
  /**
   * PATCH /resources/:id
   *
   * Update resource metadata (append-only operations - name and content are immutable)
   * Requires authentication
   * Validates request body against UpdateResourceRequest schema
   */
  router.patch('/resources/:id',
    validateRequestBody('UpdateResourceRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as UpdateResourceRequest;
      const user = c.get('user');
      const config = c.get('config');
      const basePath = config.services.filesystem!.path;

      // Check resource exists using Layer 3
      const doc = await ResourceQueryService.getResourceMetadata(id, config);
      if (!doc) {
        throw new HTTPException(404, { message: 'Resource not found' });
      }

      const eventStore = await createEventStore(basePath);

      // Emit archived/unarchived events (event store updates Layer 3, graph consumer updates Layer 4)
      if (body.archived !== undefined && body.archived !== doc.archived) {
        if (body.archived) {
          await eventStore.appendEvent({
            type: 'resource.archived',
            resourceId: resourceId(id),
            userId: userId(user.id),
            version: 1,
            payload: {
              reason: undefined,
            },
          });
        } else {
          await eventStore.appendEvent({
            type: 'resource.unarchived',
            resourceId: resourceId(id),
            userId: userId(user.id),
            version: 1,
            payload: {},
          });
        }
      }

      // Emit entity tag change events (event store updates Layer 3, graph consumer updates Layer 4)
      if (body.entityTypes && doc.entityTypes) {
        const added = body.entityTypes.filter((et: string) => !(doc.entityTypes || []).includes(et));
        const removed = (doc.entityTypes || []).filter((et: string) => !body.entityTypes!.includes(et));

        for (const entityType of added) {
          await eventStore.appendEvent({
            type: 'entitytag.added',
            resourceId: resourceId(id),
            userId: userId(user.id),
            version: 1,
            payload: {
              entityType,
            },
          });
        }
        for (const entityType of removed) {
          await eventStore.appendEvent({
            type: 'entitytag.removed',
            resourceId: resourceId(id),
            userId: userId(user.id),
            version: 1,
            payload: {
              entityType,
            },
          });
        }
      }

      // Read annotations from Layer 3
      const annotations = await AnnotationQueryService.getAllAnnotations(id, config);
      const entityReferences = annotations.filter(a => {
        if (a.motivation !== 'linking') return false;
        const entityTypes = getEntityTypes({ body: a.body });
        return entityTypes.length > 0;
      });

      // Return optimistic response (content NOT included - must be fetched separately)
      const response: GetResourceResponse = {
        resource: {
          ...doc,
          archived: body.archived !== undefined ? body.archived : doc.archived,
          entityTypes: body.entityTypes !== undefined ? body.entityTypes : doc.entityTypes,
        },
        annotations,
        entityReferences,
      };

      return c.json(response);
    }
  );
}
