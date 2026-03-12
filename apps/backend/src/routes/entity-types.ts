/**
 * Entity Types Routes
 *
 * GET emits mark:entity-types-requested on the EventBus, awaits the Gatherer's response.
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
import { eventBusRequest } from '../utils/event-bus-request';

type AddEntityTypeRequest = components['schemas']['AddEntityTypeRequest'];
type BulkAddEntityTypesRequest = components['schemas']['BulkAddEntityTypesRequest'];

// Create router with auth middleware
export const entityTypesRouter = new Hono<{ Variables: { user: User; config: EnvironmentConfig; eventBus: EventBus; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>();
entityTypesRouter.use('/api/entity-types/*', authMiddleware);

/**
 * GET /api/entity-types
 * Get list of available entity types via EventBus → Gatherer
 */
entityTypesRouter.get('/api/entity-types', async (c) => {
  const eventBus = c.get('eventBus');
  const correlationId = crypto.randomUUID();

  const response = await eventBusRequest(
    eventBus,
    'mark:entity-types-requested',
    { correlationId },
    'mark:entity-types-result',
    'mark:entity-types-failed',
  );
  return c.json(response, 200);
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
