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
import { createEventStore } from '../services/event-store-service';
import { getFilesystemConfig } from '../config/environment-loader';
import type { components } from '@semiont/api-client';

type AddEntityTypeRequest = components['schemas']['AddEntityTypeRequest'];
type AddEntityTypeResponse = components['schemas']['AddEntityTypeResponse'];
type BulkAddEntityTypesRequest = components['schemas']['BulkAddEntityTypesRequest'];
type GetEntityTypesResponse = components['schemas']['GetEntityTypesResponse'];

/**
 * Read entity types from Layer 3 projection
 */
async function getEntityTypesFromLayer3(): Promise<string[]> {
  const config = getFilesystemConfig();
  const entityTypesPath = path.join(
    config.path,
    'projections',
    'entity-types',
    'entity-types.json'
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
export const entityTypesRouter = new Hono<{ Variables: { user: User } }>();
entityTypesRouter.use('/api/entity-types/*', authMiddleware);

/**
 * GET /api/entity-types
 * Get list of available entity types from Layer 3 projection
 */
entityTypesRouter.get('/api/entity-types', async (c) => {
  try {
    const entityTypes = await getEntityTypesFromLayer3();

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
 * Emits entitytype.added event → Layer 2 → Layer 3 projection → Layer 4 (graph)
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

    // Emit event (no documentId for system-level events)
    const basePath = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath);
    await eventStore.appendEvent({
      type: 'entitytype.added',
      // documentId: undefined - system-level event
      userId: user.id,
      version: 1,
      payload: {
        entityType: body.tag,
      },
    });

    // Read from Layer 3
    const entityTypes = await getEntityTypesFromLayer3();

    const response: AddEntityTypeResponse = { success: true, entityTypes };
    return c.json(response, 200);
  }
);

/**
 * POST /api/entity-types/bulk
 * Add multiple entity types to the collection (append-only, requires moderator/admin)
 * Emits one entitytype.added event per tag → Layer 2 → Layer 3 projection → Layer 4 (graph)
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
    const basePath2 = getFilesystemConfig().path;
    const eventStore = await createEventStore(basePath2);

    // Emit one event per entity type (no documentId)
    for (const tag of body.tags) {
      await eventStore.appendEvent({
        type: 'entitytype.added',
        // documentId: undefined - system-level event
        userId: user.id,
        version: 1,
        payload: {
          entityType: tag,
        },
      });
    }

    // Read from Layer 3
    const entityTypes = await getEntityTypesFromLayer3();

    const response: AddEntityTypeResponse = { success: true, entityTypes };
    return c.json(response, 200);
  }
);
