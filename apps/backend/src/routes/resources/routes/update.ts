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
import { ResourceContext, AnnotationContext, ResourceOperations } from '@semiont/make-meaning';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { userId, resourceId } from '@semiont/core';
import { getEntityTypes } from '@semiont/ontology';

type Annotation = components['schemas']['Annotation'];

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

      // Check resource exists using view storage
      const doc = await ResourceContext.getResourceMetadata(resourceId(id), config);
      if (!doc) {
        throw new HTTPException(404, { message: 'Resource not found' });
      }

      const { eventStore } = c.get('makeMeaning');

      // Delegate to make-meaning service for business logic
      await ResourceOperations.updateResource(
        {
          resourceId: resourceId(id),
          userId: userId(user.id),
          currentArchived: doc.archived,
          updatedArchived: body.archived,
          currentEntityTypes: doc.entityTypes,
          updatedEntityTypes: body.entityTypes,
        },
        eventStore
      );

      // Read annotations from view storage
      const annotations = await AnnotationContext.getAllAnnotations(resourceId(id), config);
      const entityReferences = annotations.filter((a: Annotation) => {
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
