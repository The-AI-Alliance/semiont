/**
 * Entity Types Routes
 *
 * GET returns entity types from view storage projection.
 * POST/bulk POST emit events and return 202 Accepted.
 * The frontend refreshes entity types via query invalidation.
 */

import { Hono } from 'hono';
import type { User } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { validateRequestBody } from '../middleware/validate-openapi';
import type { components } from '@semiont/core';
import { userId, type EnvironmentConfig, type EventBus } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';
import { readEntityTypesProjection } from '@semiont/make-meaning';
import { getLogger } from '../logger';

// Lazy initialization to avoid calling getLogger() at module load time
const getRouteLogger = () => getLogger().child({ component: 'entity-types' });

type AddEntityTypeRequest = components['schemas']['AddEntityTypeRequest'];
type BulkAddEntityTypesRequest = components['schemas']['BulkAddEntityTypesRequest'];
type GetEntityTypesResponse = components['schemas']['GetEntityTypesResponse'];

// Create router with auth middleware
export const entityTypesRouter = new Hono<{ Variables: { user: User; config: EnvironmentConfig; eventBus: EventBus; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>();
entityTypesRouter.use('/api/entity-types/*', authMiddleware);

/**
 * GET /api/entity-types
 * Get list of available entity types from view storage projection
 */
entityTypesRouter.get('/api/entity-types', async (c) => {
  try {
    const config = c.get('config');
    const entityTypes = await readEntityTypesProjection(config);

    const response: GetEntityTypesResponse = { entityTypes };
    return c.json(response, 200);
  } catch (error) {
    getRouteLogger().error('Error fetching entity types', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return c.json({ error: 'Failed to fetch entity types', details: error instanceof Error ? error.message : String(error) }, 500);
  }
});

/**
 * POST /api/entity-types
 * Add a new entity type (append-only, requires moderator/admin)
 */
entityTypesRouter.post('/api/entity-types',
  validateRequestBody('AddEntityTypeRequest'),
  async (c) => {
    const user = c.get('user');
    if (!user.isModerator && !user.isAdmin) {
      return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
    }

    const body = c.get('validatedBody') as AddEntityTypeRequest;
    const eventBus = c.get('eventBus');
    eventBus.get('mark:add-entity-type').next({ tag: body.tag, userId: userId(user.id) });

    return c.body(null, 202);
  }
);

/**
 * POST /api/entity-types/bulk
 * Add multiple entity types (append-only, requires moderator/admin)
 */
entityTypesRouter.post('/api/entity-types/bulk',
  validateRequestBody('BulkAddEntityTypesRequest'),
  async (c) => {
    const user = c.get('user');
    if (!user.isModerator && !user.isAdmin) {
      return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
    }

    const body = c.get('validatedBody') as BulkAddEntityTypesRequest;
    const eventBus = c.get('eventBus');

    for (const tag of body.tags) {
      eventBus.get('mark:add-entity-type').next({ tag, userId: userId(user.id) });
    }

    return c.body(null, 202);
  }
);
