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
import {
  CREATION_METHODS,
  resourceId as makeResourceId,
  type ResourceId,
  userId,
} from '@semiont/core';
import { ResourceContext, ResourceOperations } from '@semiont/make-meaning';
import { type CloneToken, cloneToken as makeCloneToken } from '@semiont/api-client';
import type { ResourcesRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

import { getPrimaryRepresentation, getResourceEntityTypes } from '@semiont/api-client';

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
    const sourceDoc = await ResourceContext.getResourceMetadata(tokenData.resourceId, config);
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

      const token = makeCloneToken(body.token);
      const tokenData = cloneTokens.get(token);
      if (!tokenData) {
        throw new HTTPException(404, { message: 'Invalid or expired token' });
      }

      if (new Date() > tokenData.expiresAt) {
        cloneTokens.delete(token);
        throw new HTTPException(404, { message: 'Token expired' });
      }

      const config = c.get('config');
      const { eventStore, repStore } = c.get('makeMeaning');

      // Get source resource from materialized views (source of truth)
      const sourceDoc = await ResourceContext.getResourceMetadata(tokenData.resourceId, config);
      if (!sourceDoc) {
        throw new HTTPException(404, { message: 'Source resource not found' });
      }

      // Get source format and validate it's a supported ContentFormat
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      const mediaType = primaryRep?.mediaType || 'text/plain';

      // Validate mediaType is a supported ContentFormat (validation at periphery)
      const validFormats = ['text/plain', 'text/markdown'] as const;
      const format: 'text/plain' | 'text/markdown' = validFormats.includes(mediaType as any)
        ? (mediaType as 'text/plain' | 'text/markdown')
        : 'text/plain';

      // Create cloned resource via event sourcing (emits resource.created with creationMethod: CLONE)
      const result = await ResourceOperations.createResource(
        {
          name: body.name,
          content: Buffer.from(body.content),
          format,
          entityTypes: getResourceEntityTypes(sourceDoc),
          creationMethod: CREATION_METHODS.CLONE,
        },
        userId(user.id),
        eventStore,
        repStore,
        config
      );

      // Archive original if requested
      if (body.archiveOriginal) {
        await ResourceOperations.updateResource(
          {
            resourceId: tokenData.resourceId,
            userId: userId(user.id),
            currentArchived: sourceDoc.archived,
            updatedArchived: true,
          },
          eventStore
        );
      }

      // Clean up token
      cloneTokens.delete(token);

      const response: CreateResourceFromTokenResponse = result;

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
    const { repStore } = c.get('makeMeaning');

    // Look up resource from materialized views (source of truth, not graph DB)
    const sourceDoc = await ResourceContext.getResourceMetadata(makeResourceId(id), config);
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
