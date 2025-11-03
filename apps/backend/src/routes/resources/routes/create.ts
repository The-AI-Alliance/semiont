/**
 * Create Resource Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import {
  CREATION_METHODS,
  type CreationMethod,
  generateUuid,
  userId,
  resourceId,
} from '@semiont/core';
import type { ResourcesRouterType } from '../shared';
import { createEventStore } from '../../../services/event-store-service';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';

type CreateResourceRequest = components['schemas']['CreateResourceRequest'];
type CreateResourceResponse = components['schemas']['CreateResourceResponse'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export function registerCreateResource(router: ResourcesRouterType) {
  /**
   * POST /api/resources
   *
   * Create a new resource
   * Requires authentication
   * Validates request body against CreateResourceRequest schema
   */
  router.post('/api/resources',
    validateRequestBody('CreateResourceRequest'),
    async (c) => {
      const body = c.get('validatedBody') as CreateResourceRequest;
      const user = c.get('user');
      const config = c.get('config');
      const basePath = config.services.filesystem!.path;
      const repStore = new FilesystemRepresentationStore({ basePath });

      const rId = resourceId(generateUuid());

      // Store representation (Layer 1)
      const contentBuffer = Buffer.from(body.content);
      const storedRep = await repStore.store(contentBuffer, {
        mediaType: body.format,
        language: body.language,
        rel: 'original',
      });

      // Subscribe GraphDB consumer to new resource BEFORE emitting event
      // This ensures the consumer receives the resource.created event
      try {
        const { getGraphConsumer } = await import('../../../events/consumers/graph-consumer');
        const consumer = await getGraphConsumer(config);
        await consumer.subscribeToResource(rId);
      } catch (error) {
        console.error('[CreateResource] Failed to subscribe GraphDB consumer:', error);
        // Don't fail the request - consumer can catch up later
      }

      // Validate and use creationMethod from request body, or default to API
      const validCreationMethods = Object.values(CREATION_METHODS) as string[];
      const creationMethod: CreationMethod = body.creationMethod && validCreationMethods.includes(body.creationMethod)
        ? body.creationMethod as CreationMethod
        : CREATION_METHODS.API;

      // Emit resource.created event (consumer will update GraphDB)
      const eventStore = await createEventStore(basePath);
      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: rId,
        userId: userId(user.id),
        version: 1,
        payload: {
          name: body.name,
          format: body.format,
          contentChecksum: storedRep.checksum,
          creationMethod,
          entityTypes: body.entityTypes,
          language: body.language,
          isDraft: false,
          generatedFrom: undefined,
          generationPrompt: undefined,
        },
      });

      // Return optimistic response with W3C-compliant HTTP URI
      const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
      const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;

      const resourceMetadata: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': `${normalizedBase}/resources/${rId}`,
        name: body.name,
        archived: false,
        entityTypes: body.entityTypes || [],
        creationMethod,
        dateCreated: new Date().toISOString(),
        wasAttributedTo: userToAgent(user),
        representations: [{
          mediaType: body.format,
          checksum: storedRep.checksum,
          rel: 'original',
          language: body.language,
        }],
      };

      const response: CreateResourceResponse = {
        resource: resourceMetadata,
        annotations: [],
      };

      return c.json(response, 201);
    }
  );
}
