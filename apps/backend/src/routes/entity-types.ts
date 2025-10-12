import { createRoute, z } from '@hono/zod-openapi';
import { OpenAPIHono } from '@hono/zod-openapi';
import { User } from '@prisma/client';
import { AddEntityTypeResponseSchema } from '@semiont/sdk';
import { authMiddleware } from '../middleware/auth';
import { getGraphDatabase } from '../graph/factory';

// Create router with auth middleware
export const entityTypesRouter = new OpenAPIHono<{ Variables: { user: User } }>();
entityTypesRouter.use('/api/entity-types/*', authMiddleware);

// GET /api/entity-types
const getEntityTypesRoute = createRoute({
  method: 'get',
  path: '/api/entity-types',
  summary: 'Get Entity Types',
  description: 'Get list of available entity types for references',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            entityTypes: z.array(z.string()),
          }),
        },
      },
      description: 'Entity types retrieved successfully',
    },
  },
});

entityTypesRouter.openapi(getEntityTypesRoute, async (c) => {
  const graphDb = await getGraphDatabase();
  const entityTypes = await graphDb.getEntityTypes();
  return c.json({ entityTypes }, 200);
});

// POST /api/entity-types
const addEntityTypeRoute = createRoute({
  method: 'post',
  path: '/api/entity-types',
  summary: 'Add Entity Type',
  description: 'Add a new entity type to the collection (append-only, requires moderator/admin)',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            tag: z.string().min(1).max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: AddEntityTypeResponseSchema,
        },
      },
      description: 'Entity type added successfully',
    },
    403: {
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: 'Forbidden - Moderator or Admin access required',
    },
  },
});

entityTypesRouter.openapi(addEntityTypeRoute, async (c) => {
  // Check moderation permissions
  const user = c.get('user');
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }

  const { tag } = c.req.valid('json');
  const graphDb = await getGraphDatabase();

  await graphDb.addEntityType(tag);
  const entityTypes = await graphDb.getEntityTypes();

  return c.json({ success: true, entityTypes }, 200);
});

// POST /api/entity-types/bulk
const bulkAddEntityTypesRoute = createRoute({
  method: 'post',
  path: '/api/entity-types/bulk',
  summary: 'Bulk Add Entity Types',
  description: 'Add multiple entity types to the collection (append-only, requires moderator/admin)',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            tags: z.array(z.string().min(1).max(100)),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: AddEntityTypeResponseSchema,
        },
      },
      description: 'Entity types added successfully',
    },
    403: {
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: 'Forbidden - Moderator or Admin access required',
    },
  },
});

entityTypesRouter.openapi(bulkAddEntityTypesRoute, async (c) => {
  // Check moderation permissions
  const user = c.get('user');
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }

  const { tags } = c.req.valid('json');
  const graphDb = await getGraphDatabase();

  await graphDb.addEntityTypes(tags);
  const entityTypes = await graphDb.getEntityTypes();

  return c.json({ success: true, entityTypes }, 200);
});