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
import { getGraphDatabase } from '@semiont/graph';
import {
  CREATION_METHODS,
  generateUuid,
  resourceId as makeResourceId,
  type ResourceId,
} from '@semiont/core';
import { resourceUri, type CloneToken, cloneToken as makeCloneToken } from '@semiont/api-client';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
import { FilesystemRepresentationStore } from '@semiont/content';
import { getPrimaryRepresentation, getResourceId, getResourceEntityTypes } from '@semiont/api-client';

type GetResourceByTokenResponse = components['schemas']['GetResourceByTokenResponse'];
type CreateResourceFromTokenRequest = components['schemas']['CreateResourceFromTokenRequest'];
type CreateResourceFromTokenResponse = components['schemas']['CreateResourceFromTokenResponse'];
type CloneResourceWithTokenResponse = components['schemas']['CloneResourceWithTokenResponse'];

// Simple in-memory token store (replace with Redis/DB in production)
const cloneTokens = new Map<CloneToken, { resourceId: ResourceId; expiresAt: Date }>();

export function registerTokenRoutes(router: ResourcesRouterType) {
  /**
   * GET /api/resources/token/:token
   *
   * Retrieve a resource using a clone token
   * Requires authentication
   */
  router.get('/api/resources/token/:token', async (c) => {
    const { token: tokenStr } = c.req.param();
    const token = makeCloneToken(tokenStr);

    const tokenData = cloneTokens.get(token);
    if (!tokenData) {
      throw new HTTPException(404, { message: 'Invalid or expired token' });
    }

    if (new Date() > tokenData.expiresAt) {
      cloneTokens.delete(token);
      throw new HTTPException(404, { message: 'Token expired' });
    }

    const config = c.get('config');
    const graphDb = await getGraphDatabase(config);
    const sourceDoc = await graphDb.getResource(resourceUri(tokenData.resourceId));
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
      const config = c.get('config');
      const basePath = config.services.filesystem!.path;

      const token = makeCloneToken(body.token);
      const tokenData = cloneTokens.get(token);
      if (!tokenData) {
        throw new HTTPException(404, { message: 'Invalid or expired token' });
      }

      if (new Date() > tokenData.expiresAt) {
        cloneTokens.delete(token);
        throw new HTTPException(404, { message: 'Token expired' });
      }
    const graphDb = await getGraphDatabase(config);
      const projectRoot = config._metadata?.projectRoot;
      const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

      // Get source resource
      const sourceDoc = await graphDb.getResource(resourceUri(tokenData.resourceId));
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
        entityTypes: getResourceEntityTypes(sourceDoc),
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
        await graphDb.updateResource(resourceUri(tokenData.resourceId), {
          archived: true
        });
      }

      // Clean up token
      cloneTokens.delete(token);

      // Get annotations
      const savedDocId = getResourceId(savedDoc);
      if (!savedDocId) {
        return c.json({ error: 'Resource must have an id' }, 500);
      }
      const result = await graphDb.listAnnotations({ resourceId: makeResourceId(savedDocId) });

      const response: CreateResourceFromTokenResponse = {
        resource: savedDoc,
        annotations: result.annotations,
      };

      return c.json(response, 201);
    }
  );

  /**
   * POST /resources/:id/clone-with-token
   *
   * Generate a temporary token for cloning a resource
   * Requires authentication
   */
  router.post('/resources/:id/clone-with-token', async (c) => {
    const { id } = c.req.param();
    const config = c.get('config');
    const basePath = config.services.filesystem!.path;
    const graphDb = await getGraphDatabase(config);
    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    const sourceDoc = await graphDb.getResource(resourceUri(resourceUri(id)));
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
    const tokenStr = `clone_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
    const token = makeCloneToken(tokenStr);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    cloneTokens.set(token, {
      resourceId: makeResourceId(id),
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
