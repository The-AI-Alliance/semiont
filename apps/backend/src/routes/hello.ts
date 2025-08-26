import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { HelloResponseSchema, ErrorResponseSchema } from '../openapi';
import { authMiddleware } from '../middleware/auth';
import { User } from '@prisma/client';

// Define parameter schema
const HelloParamsSchema = z.object({
  name: z.string().max(100).optional().openapi({
    param: {
      name: 'name',
      in: 'path',
    },
    example: 'Alice',
    description: 'Optional name for personalized greeting',
  }),
});

// Define the hello route
export const helloRoute = createRoute({
  method: 'get',
  path: '/api/hello/{name}',
  summary: 'Get Hello Message',
  description: 'Returns a personalized greeting message',
  tags: ['General'],
  security: [{ bearerAuth: [] }],
  request: {
    params: HelloParamsSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: HelloResponseSchema,
        },
      },
      description: 'Successful greeting',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

// Define route without name parameter
export const helloRouteNoName = createRoute({
  method: 'get',
  path: '/api/hello',
  summary: 'Get Hello Message',
  description: 'Returns a greeting message',
  tags: ['General'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: HelloResponseSchema,
        },
      },
      description: 'Successful greeting',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
  },
});

// Create hello router
export const helloRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth middleware to hello routes
helloRouter.use('/api/hello/*', authMiddleware);

helloRouter.openapi(helloRoute, async (c) => {
  const user = c.get('user');
  const { name } = c.req.valid('param');
  
  const personalizedName = name && name.length <= 100 ? name : 'World';
  
  return c.json({
    message: `Hello, ${personalizedName}! Welcome to Semiont.`,
    timestamp: new Date().toISOString(),
    platform: 'Semiont Semantic Knowledge Platform',
    user: user ? user.email : undefined,
  }, 200);
});

helloRouter.openapi(helloRouteNoName, async (c) => {
  const user = c.get('user');
  
  return c.json({
    message: 'Hello, World! Welcome to Semiont.',
    timestamp: new Date().toISOString(),
    platform: 'Semiont Semantic Knowledge Platform',
    user: user ? user.email : undefined,
  }, 200);
});