import { createRoute, z } from '@hono/zod-openapi';
import { OpenAPIHono } from '@hono/zod-openapi';
import { User } from '@prisma/client';
import { AddReferenceTypeResponseSchemaOpenAPI as AddReferenceTypeResponseSchema } from '@semiont/sdk';
import { authMiddleware } from '../middleware/auth';
import { getGraphDatabase } from '../graph/factory';

// Create router with auth middleware
export const referenceTypesRouter = new OpenAPIHono<{ Variables: { user: User } }>();
referenceTypesRouter.use('/api/reference-types/*', authMiddleware);

// GET /api/reference-types
const getReferenceTypesRoute = createRoute({
  method: 'get',
  path: '/api/reference-types',
  summary: 'Get Reference Types',
  description: 'Get list of available reference types',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            referenceTypes: z.array(z.string()),
          }),
        },
      },
      description: 'Reference types retrieved successfully',
    },
  },
});

referenceTypesRouter.openapi(getReferenceTypesRoute, async (c) => {
  const graphDb = await getGraphDatabase();
  const referenceTypes = await graphDb.getReferenceTypes();
  return c.json({ referenceTypes }, 200);
});

// POST /api/reference-types
const addReferenceTypeRoute = createRoute({
  method: 'post',
  path: '/api/reference-types',
  summary: 'Add Reference Type',
  description: 'Add a new reference type to the collection (append-only, requires moderator/admin)',
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
          schema: AddReferenceTypeResponseSchema,
        },
      },
      description: 'Reference type added successfully',
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

referenceTypesRouter.openapi(addReferenceTypeRoute, async (c) => {
  // Check moderation permissions
  const user = c.get('user');
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }

  const { tag } = c.req.valid('json');
  const graphDb = await getGraphDatabase();

  await graphDb.addReferenceType(tag);
  const referenceTypes = await graphDb.getReferenceTypes();

  return c.json({ success: true, referenceTypes }, 200);
});

// POST /api/reference-types/bulk
const bulkAddReferenceTypesRoute = createRoute({
  method: 'post',
  path: '/api/reference-types/bulk',
  summary: 'Bulk Add Reference Types',
  description: 'Add multiple reference types to the collection (append-only, requires moderator/admin)',
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
          schema: AddReferenceTypeResponseSchema,
        },
      },
      description: 'Reference types added successfully',
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

referenceTypesRouter.openapi(bulkAddReferenceTypesRoute, async (c) => {
  // Check moderation permissions
  const user = c.get('user');
  if (!user.isModerator && !user.isAdmin) {
    return c.json({ error: 'Forbidden: Moderator or Admin access required' }, 403);
  }

  const { tags } = c.req.valid('json');
  const graphDb = await getGraphDatabase();

  await graphDb.addReferenceTypes(tags);
  const referenceTypes = await graphDb.getReferenceTypes();

  return c.json({ success: true, referenceTypes }, 200);
});