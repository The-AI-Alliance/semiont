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
import { promises as fs } from 'fs';
import * as path from 'path';
import { authMiddleware } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userId, type EnvironmentConfig } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';

type AddEntityTypeRequest = components['schemas']['AddEntityTypeRequest'];
type AddEntityTypeResponse = components['schemas']['AddEntityTypeResponse'];
type BulkAddEntityTypesRequest = components['schemas']['BulkAddEntityTypesRequest'];
type GetEntityTypesResponse = components['schemas']['GetEntityTypesResponse'];

/**
 * Read entity types from view storage projection
 */
async function getEntityTypesFromLayer3(config: EnvironmentConfig): Promise<string[]> {
  // Resolve basePath against project root if relative
  const configuredPath = config.services.filesystem!.path;
  const projectRoot = config._metadata?.projectRoot;
  let basePath: string;
  if (path.isAbsolute(configuredPath)) {
    basePath = configuredPath;
  } else if (projectRoot) {
    basePath = path.resolve(projectRoot, configuredPath);
  } else {
    basePath = path.resolve(configuredPath);
  }

  const entityTypesPath = path.join(
    basePath,
    'projections',
    '__system__',
    'entitytypes.json'
  );

  try {
    const content = await fs.readFile(entityTypesPath, 'utf-8');
    const projection = JSON.parse(content);
    return projection.entityTypes || [];
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File doesn't exist yet - return empty array
      return [];
    }
    throw error;
  }
}

// Create router with auth middleware
export const entityTypesRouter = new Hono<{ Variables: { user: User; config: EnvironmentConfig; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>();
entityTypesRouter.use('/api/entity-types/*', authMiddleware);

/**
 * GET /api/entity-types
 * Get list of available entity types from view storage projection
 */
entityTypesRouter.get('/api/entity-types', async (c) => {
  try {
    const config = c.get('config');
    const entityTypes = await getEntityTypesFromLayer3(config);

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
 * Emits entitytype.added event → Event Store → view storage projection → Graph Database (graph)
 */
entityTypesRouter.post('/api/entity-types',
  validateRequestBody('AddEntityTypeRequest'),
  async (c) => {
    // Check moderation permissions
    const user = c.get('user');
    const config = c.get('config');
    if (!user.isModerator && !user.isAdmin) {
      return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
    }

    const body = c.get('validatedBody') as AddEntityTypeRequest;

    // Emit event (no resourceId for system-level events)
    const { eventStore } = c.get('makeMeaning');
    await eventStore.appendEvent({
      type: 'entitytype.added',
      // resourceId: undefined - system-level event
      userId: userId(user.id),
      version: 1,
      payload: {
        entityType: body.tag,
      },
    });

    // Read from view storage
    const entityTypes = await getEntityTypesFromLayer3(config);

    const response: AddEntityTypeResponse = { success: true, entityTypes };
    return c.json(response, 200);
  }
);

/**
 * POST /api/entity-types/bulk
 * Add multiple entity types to the collection (append-only, requires moderator/admin)
 * Emits one entitytype.added event per tag → Event Store → view storage projection → Graph Database (graph)
 */
entityTypesRouter.post('/api/entity-types/bulk',
  validateRequestBody('BulkAddEntityTypesRequest'),
  async (c) => {
    // Check moderation permissions
    const user = c.get('user');
    const config = c.get('config');
    if (!user.isModerator && !user.isAdmin) {
      return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
    }

    const body = c.get('validatedBody') as BulkAddEntityTypesRequest;
    const { eventStore } = c.get('makeMeaning');

    // Emit one event per entity type (no resourceId)
    for (const tag of body.tags) {
      await eventStore.appendEvent({
        type: 'entitytype.added',
        // resourceId: undefined - system-level event
        userId: userId(user.id),
        version: 1,
        payload: {
          entityType: tag,
        },
      });
    }

    // Read from view storage
    const entityTypes = await getEntityTypesFromLayer3(config);

    const response: AddEntityTypeResponse = { success: true, entityTypes };
    return c.json(response, 200);
  }
);
