/**
 * Create Resource from Annotation Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import type { components } from '@semiont/api-client';
import {
  CREATION_METHODS,
  generateUuid,
} from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
import type { ResourcesRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import { userToAgent } from '../../../utils/id-generator';
import { getTargetSource } from '../../../lib/annotation-utils';
import { getEntityTypes } from '@semiont/api-client';
import { getFilesystemConfig } from '../../../config/environment-loader';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getResourceId } from '../../../utils/resource-helpers';

type CreateFromAnnotationRequest = components['schemas']['CreateFromAnnotationRequest'];
type CreateFromAnnotationResponse = components['schemas']['CreateFromAnnotationResponse'];

export function registerCreateResourceFromAnnotation(router: ResourcesRouterType) {
  /**
   * POST /api/resources/from-annotation/:annotationId
   *
   * Create a new resource from an annotation/reference
   * Requires authentication
   * Validates request body against CreateFromAnnotationRequest schema
   * Returns 201 with resource and annotations
   */
  router.post('/api/resources/from-annotation/:annotationId',
    validateRequestBody('CreateFromAnnotationRequest'),
    async (c) => {
      const { annotationId } = c.req.param();
      const body = c.get('validatedBody') as CreateFromAnnotationRequest;
      const user = c.get('user');
      const basePath = getFilesystemConfig().path;
      const graphDb = await getGraphDatabase();
      const repStore = new FilesystemRepresentationStore({ basePath });

      const annotation = await AnnotationQueryService.getAnnotation(annotationId, body.resourceId);
      if (!annotation) {
        throw new HTTPException(404, { message: 'Annotation not found' });
      }

      const resourceId = generateUuid();

      // Store representation
      const storedRep = await repStore.store(Buffer.from(body.content), {
        mediaType: body.format,
        rel: 'original',
      });

      const resource: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': `http://localhost:4000/resources/${resourceId}`,
        name: body.name,
        entityTypes: getEntityTypes(annotation),
        representations: [{
          mediaType: body.format,
          checksum: storedRep.checksum,
          rel: 'original',
        }],
        archived: false,
        dateCreated: new Date().toISOString(),
        wasAttributedTo: userToAgent(user),
        creationMethod: CREATION_METHODS.REFERENCE,
        sourceAnnotationId: annotationId,
        sourceResourceId: getTargetSource(annotation.target),
      };

      const savedDoc = await graphDb.createResource(resource);

      // Update the annotation to resolve to the new resource
      await graphDb.resolveReference(annotationId, getResourceId(savedDoc));

      const result = await graphDb.listAnnotations({ resourceId: getResourceId(savedDoc) });

      const response: CreateFromAnnotationResponse = {
        resource: savedDoc,
        annotations: result.annotations,
      };

      return c.json(response, 201);
    }
  );
}
