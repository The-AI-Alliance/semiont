/**
 * Entity Types Routes - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request bodies with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { Hono } from 'hono';
import type { User } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { getGraphDatabase } from '../graph/factory';
import { validateRequestBody } from '../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

type AddEntityTypeRequest = components['schemas']['AddEntityTypeRequest'];
type AddEntityTypeResponse = components['schemas']['AddEntityTypeResponse'];
type BulkAddEntityTypesRequest = components['schemas']['BulkAddEntityTypesRequest'];
type GetEntityTypesResponse = components['schemas']['GetEntityTypesResponse'];

// Create router with auth middleware
export const entityTypesRouter = new Hono<{ Variables: { user: User } }>();
entityTypesRouter.use('/api/entity-types/*', authMiddleware);

/**
 * GET /api/entity-types
 * Get list of available entity types for references
 */
entityTypesRouter.get('/api/entity-types', async (c) => {
  try {
    const graphDb = await getGraphDatabase();
    const entityTypes = await graphDb.getEntityTypes();

    const response: GetEntityTypesResponse = { entityTypes };
    return c.json(response, 200);
  } catch (error) {
    console.error('[EntityTypes] Error fetching entity types:', error);
    return c.json({ error: 'Failed to fetch entity types', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

/**
 * POST /api/entity-types
 * Add a new entity type to the collection (append-only, requires moderator/admin)
 */
entityTypesRouter.post('/api/entity-types',
  validateRequestBody('AddEntityTypeRequest'),
  async (c) => {
    // Check moderation permissions
    const user = c.get('user');
    if (!user.isModerator && !user.isAdmin) {
      return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
    }

    const body = c.get('validatedBody') as AddEntityTypeRequest;
    const graphDb = await getGraphDatabase();

    await graphDb.addEntityType(body.tag);
    const entityTypes = await graphDb.getEntityTypes();

    const response: AddEntityTypeResponse = { success: true, entityTypes };
    return c.json(response, 200);
  }
);

/**
 * POST /api/entity-types/bulk
 * Add multiple entity types to the collection (append-only, requires moderator/admin)
 */
entityTypesRouter.post('/api/entity-types/bulk',
  validateRequestBody('BulkAddEntityTypesRequest'),
  async (c) => {
    // Check moderation permissions
    const user = c.get('user');
    if (!user.isModerator && !user.isAdmin) {
      return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
    }

    const body = c.get('validatedBody') as BulkAddEntityTypesRequest;
    const graphDb = await getGraphDatabase();

    await graphDb.addEntityTypes(body.tags);
    const entityTypes = await graphDb.getEntityTypes();

    const response: AddEntityTypeResponse = { success: true, entityTypes };
    return c.json(response, 200);
  }
);
