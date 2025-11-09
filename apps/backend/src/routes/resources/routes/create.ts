/**
 * Create Resource Route - Multipart/Form-Data Version
 *
 * Handles binary content upload via multipart/form-data:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Parses multipart form data (no JSON validation middleware)
 * - Supports binary content (images, PDFs, video, etc.)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import {
  CREATION_METHODS,
  type CreationMethod,
  generateUuid,
  userId,
  resourceId,
} from '@semiont/core';
import type { ResourcesRouterType } from '../shared';
import { createEventStore } from '../../../services/event-store-service';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';

type CreateResourceResponse = components['schemas']['CreateResourceResponse'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type ContentFormat = components['schemas']['ContentFormat'];

export function registerCreateResource(router: ResourcesRouterType) {
  /**
   * POST /resources
   *
   * Create a new resource with binary content support via multipart/form-data
   * Requires authentication
   * Parses FormData (no JSON validation middleware)
   */
  router.post('/resources', async (c) => {
    const user = c.get('user');
    const config = c.get('config');

    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    // Parse multipart/form-data
    const formData = await c.req.formData();

    // Extract fields
    const name = formData.get('name') as string;
    const file = formData.get('file') as File;
    const formatRaw = formData.get('format') as string;
    const language = formData.get('language') as string | null;
    const entityTypesStr = formData.get('entityTypes') as string | null;
    const creationMethod = formData.get('creationMethod') as string | null;

    // Validate required fields
    if (!name || !file || !formatRaw) {
      throw new HTTPException(400, {
        message: 'Missing required fields: name, file, format'
      });
    }

    // Type-cast to ContentFormat (OpenAPI validates this enum at spec level)
    const format = formatRaw as ContentFormat;

    // Parse entityTypes from JSON string
    const entityTypes = entityTypesStr ? JSON.parse(entityTypesStr) : [];

    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const contentBuffer = Buffer.from(arrayBuffer);

    // Store representation (content storage)
    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    const rId = resourceId(generateUuid());

    const storedRep = await repStore.store(contentBuffer, {
      mediaType: format,
      language: language || undefined,
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

    // Validate and use creationMethod from form data, or default to API
    const validCreationMethods = Object.values(CREATION_METHODS) as string[];
    const validatedCreationMethod: CreationMethod = creationMethod && validCreationMethods.includes(creationMethod)
      ? creationMethod as CreationMethod
      : CREATION_METHODS.API;

    // Emit resource.created event (consumer will update GraphDB)
    const eventStore = await createEventStore(config);
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: rId,
      userId: userId(user.id),
      version: 1,
      payload: {
        name,
        format,
        contentChecksum: storedRep.checksum,
        creationMethod: validatedCreationMethod,
        entityTypes,
        language: language || undefined,
        isDraft: false,
        generatedFrom: undefined,
        generationPrompt: undefined,
      },
    });

    // Return optimistic response with W3C-compliant HTTP URI
    const backendUrl = config.services.backend?.publicURL;
    if (!backendUrl) {
      throw new HTTPException(500, { message: 'Backend publicURL not configured' });
    }
    const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;

    const resourceMetadata: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': `${normalizedBase}/resources/${rId}`,
      name,
      archived: false,
      entityTypes: entityTypes || [],
      creationMethod: validatedCreationMethod,
      dateCreated: new Date().toISOString(),
      wasAttributedTo: userToAgent(user),
      representations: [{
        mediaType: format,
        checksum: storedRep.checksum,
        rel: 'original',
        language: language || undefined,
      }],
    };

    const response: CreateResourceResponse = {
      resource: resourceMetadata,
      annotations: [],
    };

    return c.json(response, 201);
  });
}
