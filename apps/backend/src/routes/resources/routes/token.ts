/**
 * Token Routes - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request bodies with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import {
  CREATION_METHODS,
  generateUuid,
} from '@semiont/core';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
import { getFilesystemConfig } from '../../../config/environment-loader';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getPrimaryRepresentation, getResourceId, getEntityTypes } from '../../../utils/resource-helpers';

type GetResourceByTokenResponse = components['schemas']['GetResourceByTokenResponse'];
type CreateResourceFromTokenRequest = components['schemas']['CreateResourceFromTokenRequest'];
type CreateResourceFromTokenResponse = components['schemas']['CreateResourceFromTokenResponse'];
type CloneResourceWithTokenResponse = components['schemas']['CloneResourceWithTokenResponse'];

// Simple in-memory token store (replace with Redis/DB in production)
const cloneTokens = new Map<string, { resourceId: string; expiresAt: Date }>();

export function registerTokenRoutes(router: ResourcesRouterType) {
  /**
   * GET /api/resources/token/:token
   *
   * Retrieve a resource using a clone token
   * Requires authentication
   */
  router.get('/api/resources/token/:token', async (c) => {
    const { token } = c.req.param();

    const tokenData = cloneTokens.get(token);
    if (!tokenData) {
      throw new HTTPException(404, { message: 'Invalid or expired token' });
    }

    if (new Date() > tokenData.expiresAt) {
      cloneTokens.delete(token);
      throw new HTTPException(404, { message: 'Token expired' });
    }

    const graphDb = await getGraphDatabase();
    const sourceDoc = await graphDb.getResource(tokenData.resourceId);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source resource not found' });
    }

    // NOTE: Content is NOT included - frontend should fetch via GET /resources/:id/content

    const response: GetResourceByTokenResponse = {
      sourceResource: sourceDoc,
      expiresAt: tokenData.expiresAt.toISOString(),
    };

    return c.json(response);
  });

  /**
   * POST /api/resources/create-from-token
   *
   * Create a new resource using a clone token
   * Requires authentication
   * Validates request body against CreateResourceFromTokenRequest schema
   */
  router.post('/api/resources/create-from-token',
    validateRequestBody('CreateResourceFromTokenRequest'),
    async (c) => {
      const body = c.get('validatedBody') as CreateResourceFromTokenRequest;
      const user = c.get('user');
      const basePath = getFilesystemConfig().path;

      const tokenData = cloneTokens.get(body.token);
      if (!tokenData) {
        throw new HTTPException(404, { message: 'Invalid or expired token' });
      }

      if (new Date() > tokenData.expiresAt) {
        cloneTokens.delete(body.token);
        throw new HTTPException(404, { message: 'Token expired' });
      }

      const graphDb = await getGraphDatabase();
      const repStore = new FilesystemRepresentationStore({ basePath });

      // Get source resource
      const sourceDoc = await graphDb.getResource(tokenData.resourceId);
      if (!sourceDoc) {
        throw new HTTPException(404, { message: 'Source resource not found' });
      }

      // Create new resource
      const resourceId = generateUuid();

      // Get source format and validate it's a supported ContentFormat
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      const mediaType = primaryRep?.mediaType || 'text/plain';

      // Validate mediaType is a supported ContentFormat (validation at periphery)
      const validFormats = ['text/plain', 'text/markdown'] as const;
      const format: 'text/plain' | 'text/markdown' = validFormats.includes(mediaType as any)
        ? (mediaType as 'text/plain' | 'text/markdown')
        : 'text/plain';

      // Store representation
      const storedRep = await repStore.store(Buffer.from(body.content), {
        mediaType: format,
        rel: 'original',
      });

      const resource: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': `http://localhost:4000/resources/${resourceId}`,
        name: body.name,
        entityTypes: getEntityTypes(sourceDoc),
        representations: [{
          mediaType: format,
          checksum: storedRep.checksum,
          rel: 'original',
        }],
        archived: false,
        dateCreated: new Date().toISOString(),
        wasAttributedTo: userToAgent(user),
        creationMethod: CREATION_METHODS.CLONE,
        sourceResourceId: getResourceId(sourceDoc),
      };

      const savedDoc = await graphDb.createResource(resource);

      // Store representation
      await repStore.store(Buffer.from(body.content), {
        mediaType: format,
        rel: 'original',
      });

      // Archive original if requested
      if (body.archiveOriginal) {
        await graphDb.updateResource(tokenData.resourceId, {
          archived: true
        });
      }

      // Clean up token
      cloneTokens.delete(body.token);

      // Get annotations
      const result = await graphDb.listAnnotations({ resourceId: getResourceId(savedDoc) });

      const response: CreateResourceFromTokenResponse = {
        resource: savedDoc,
        annotations: result.annotations,
      };

      return c.json(response, 201);
    }
  );

  /**
   * POST /api/resources/:id/clone-with-token
   *
   * Generate a temporary token for cloning a resource
   * Requires authentication
   */
  router.post('/api/resources/:id/clone-with-token', async (c) => {
    const { id } = c.req.param();
    const basePath = getFilesystemConfig().path;
    const graphDb = await getGraphDatabase();
    const repStore = new FilesystemRepresentationStore({ basePath });

    const sourceDoc = await graphDb.getResource(id);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Resource not found' });
    }

    // Check if content exists
    const primaryRep = getPrimaryRepresentation(sourceDoc);
    if (!primaryRep?.checksum || !primaryRep?.mediaType) {
      throw new HTTPException(404, { message: 'Resource content not found' });
    }

    try {
      await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
    } catch {
      throw new HTTPException(404, { message: 'Resource content not found' });
    }

    // Create token
    const token = `clone_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    cloneTokens.set(token, {
      resourceId: id,
      expiresAt,
    });

    const response: CloneResourceWithTokenResponse = {
      token,
      expiresAt: expiresAt.toISOString(),
      resource: sourceDoc,
    };

    return c.json(response);
  });
}
