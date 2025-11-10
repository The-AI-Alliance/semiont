/**
 * Generate Resource from Annotation Route
 * POST /resources/{resourceId}/annotations/{annotationId}/generate-resource
 *
 * Generates a new resource from an annotation using AI
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { createEventStore } from '../../../services/event-store-service';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText, getEntityTypes } from '@semiont/api-client';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { generateResourceFromTopic } from '../../../inference/factory';
import { userToAgent } from '../../../utils/id-generator';
import { getTargetSource } from '../../../lib/annotation-utils';
import {
  CREATION_METHODS,
  generateUuid,
  type BodyOperation,
  userId,
  annotationId,
  resourceId as makeResourceId,
} from '@semiont/core';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { ResourceQueryService } from '../../../services/resource-queries';
import { validateRequestBody } from '../../../middleware/validate-openapi';

type GenerateResourceFromAnnotationRequest = components['schemas']['GenerateResourceFromAnnotationRequest'];
type GenerateResourceFromAnnotationResponse = components['schemas']['GenerateResourceFromAnnotationResponse'];
type Annotation = components['schemas']['Annotation'];

// Helper: Create resolved annotation with SpecificResource body
function createResolvedAnnotation(annotation: Annotation, resourceUri: string, user: any): Annotation {
  const bodyArray = Array.isArray(annotation.body) ? annotation.body : [];
  return {
    ...annotation,
    motivation: 'linking' as const,
    body: [
      ...bodyArray.filter(b => b.type !== 'SpecificResource'),
      {
        type: 'SpecificResource' as const,
        source: resourceUri,
        purpose: 'linking' as const,
      },
    ],
    modified: new Date().toISOString(),
    generator: userToAgent(user),
  };
}

export function registerGenerateResourceFromAnnotation(router: ResourcesRouterType) {
  /**
   * POST /resources/:resourceId/annotations/:annotationId/generate-resource
   * Generate a new resource from an annotation using AI
   */
  router.post('/resources/:resourceId/annotations/:annotationId/generate-resource',
    validateRequestBody('GenerateResourceFromAnnotationRequest'),
    async (c) => {
      const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
      const body = c.get('validatedBody') as GenerateResourceFromAnnotationRequest;
      const user = c.get('user');
      const config = c.get('config');
      const basePath = config.services.filesystem!.path;
      const projectRoot = config._metadata?.projectRoot;
      const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

      // Get annotation from view storage
      const annotation = await AnnotationQueryService.getAnnotation(
        annotationId(annotationIdParam),
        makeResourceId(resourceIdParam),
        config
      );
      if (!annotation) {
        throw new HTTPException(404, { message: 'Annotation not found' });
      }

      // Get the original resource metadata from view storage
      const targetSource = getTargetSource(annotation.target);
      const targetResourceId = targetSource.split('/').pop()!;
      const originalDoc = await ResourceQueryService.getResourceMetadata(
        makeResourceId(targetResourceId),
        config
      );
      if (!originalDoc) {
        throw new HTTPException(404, { message: 'Original resource not found' });
      }

      // Use annotation text
      const selectedText = getAnnotationExactText(annotation);

      // Extract entity types from annotation body
      const annotationEntityTypes = getEntityTypes(annotation);

      // Generate content using the proper resource generation function
      const { title, content: generatedContent } = await generateResourceFromTopic(
        selectedText,
        body.entityTypes || annotationEntityTypes,
        config,
        body.prompt,
        body.language
      );

      if (!generatedContent) {
        throw new HTTPException(500, { message: 'No content returned from generation service' });
      }

      // Create the new resource
      const resourceName = body.name || title;
      const rId = makeResourceId(generateUuid());

      // Build HTTP URI for the new resource
      const backendUrl = config.services.backend?.publicURL;
      if (!backendUrl) {
        throw new HTTPException(500, { message: 'Backend publicURL not configured' });
      }
      const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;
      const resourceUri = `${normalizedBase}/resources/${rId}`;

      // Store generated representation
      const storedRep = await repStore.store(Buffer.from(generatedContent), {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Emit resource.created event
      const eventStore = await createEventStore(config);
      await eventStore.appendEvent({
        type: 'resource.created',
        resourceId: rId,
        userId: userId(user.id),
        version: 1,
        payload: {
          name: resourceName,
          format: 'text/markdown',
          contentChecksum: storedRep.checksum,
          contentByteSize: storedRep.byteSize,
          creationMethod: CREATION_METHODS.GENERATED,
          entityTypes: body.entityTypes || annotationEntityTypes,
          language: body.language,
          isDraft: false,
          generatedFrom: annotationIdParam,
          generationPrompt: body.prompt,
        },
      });

      // Emit annotation.body.updated event to link the annotation to the new resource
      const operations: BodyOperation[] = [{
        op: 'add',
        item: {
          type: 'SpecificResource',
          source: resourceUri,
          purpose: 'linking',
        },
      }];

      await eventStore.appendEvent({
        type: 'annotation.body.updated',
        resourceId: makeResourceId(resourceIdParam),
        userId: userId(user.id),
        version: 1,
        payload: {
          annotationId: annotationId(annotationIdParam),
          operations,
        },
      });

      // Return optimistic response
      const resolvedAnnotation = createResolvedAnnotation(annotation, resourceUri, user);

      // Build ResourceDescriptor for response
      const resourceMetadata = {
        '@context': 'https://schema.org/',
        '@id': resourceUri,
        name: resourceName,
        entityTypes: body.entityTypes || annotationEntityTypes,
        representations: [{
          mediaType: 'text/markdown',
          checksum: storedRep.checksum,
          byteSize: storedRep.byteSize,
          rel: 'original' as const,
          language: body.language,
        }],
        sourceAnnotationId: annotationIdParam,
        creationMethod: CREATION_METHODS.GENERATED,
        wasAttributedTo: userToAgent(user),
        dateCreated: new Date().toISOString(),
        archived: false,
      };

      const response: GenerateResourceFromAnnotationResponse = {
        resource: resourceMetadata,
        annotation: resolvedAnnotation,
        generated: true,
      };

      return c.json(response, 201);
    }
  );
}
