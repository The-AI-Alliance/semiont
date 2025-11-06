/**
 * Create Annotation Route
 * POST /resources/{id}/annotations
 *
 * Creates a new annotation on a resource using nested path format
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { createEventStore } from '../../../services/event-store-service';
import type { components } from '@semiont/api-client';
import { getTextPositionSelector } from '@semiont/api-client';
import type { AnnotationAddedEvent } from '@semiont/core';
import { resourceId, userId } from '@semiont/core';
import { generateAnnotationId, userToAgent } from '../../../utils/id-generator';
import { validateRequestBody } from '../../../middleware/validate-openapi';

type Annotation = components['schemas']['Annotation'];
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type CreateAnnotationResponse = components['schemas']['CreateAnnotationResponse'];

export function registerCreateAnnotation(router: ResourcesRouterType) {
  /**
   * POST /resources/:id/annotations
   * Create a new annotation/reference in a resource
   */
  router.post('/resources/:id/annotations',
    validateRequestBody('CreateAnnotationRequest'),
    async (c) => {
      const { id } = c.req.param();
      const request = c.get('validatedBody') as CreateAnnotationRequest;
      const user = c.get('user');
      const config = c.get('config');

      // Generate annotation ID
      let annotationId: string;
      try {
        const backendUrl = config.services.backend?.publicURL;
        if (!backendUrl) {
          throw new Error('Backend publicURL not configured');
        }
        annotationId = generateAnnotationId(backendUrl);
      } catch (error) {
        console.error('Failed to generate annotation ID:', error);
        throw new HTTPException(500, { message: 'Failed to create annotation' });
      }

      // Extract TextPositionSelector (required for creating annotations)
      const posSelector = getTextPositionSelector(request.target.selector);
      if (!posSelector) {
        throw new HTTPException(400, { message: 'TextPositionSelector required for creating annotations' });
      }

      // Validation ensures motivation is present (it's required in schema)
      if (!request.motivation) {
        throw new HTTPException(400, { message: 'motivation is required' });
      }

      // Build annotation object (includes W3C required @context and type)
      const annotation: Omit<Annotation, 'creator' | 'created'> = {
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        'type': 'Annotation' as const,
        id: annotationId,
        motivation: request.motivation,
        target: request.target,
        body: request.body as Annotation['body'],
        modified: new Date().toISOString(),
      };

      // Emit unified annotation.added event
      const eventStore = await createEventStore(config);
      const eventPayload: Omit<AnnotationAddedEvent, 'id' | 'timestamp'> = {
        type: 'annotation.added',
        resourceId: resourceId(id),
        userId: userId(user.id),
        version: 1,
        payload: {
          annotation,
        },
      };
      await eventStore.appendEvent(eventPayload);

      // Return optimistic response
      const response: CreateAnnotationResponse = {
        annotation: {
          ...annotation,
          creator: userToAgent(user),
          created: new Date().toISOString(),
        },
      };

      return c.json(response, 201);
    }
  );
}
