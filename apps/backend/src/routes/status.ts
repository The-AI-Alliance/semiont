import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import {
  StatusResponseSchema,
  ErrorResponseSchema,
} from '@semiont/sdk';
import { authMiddleware } from '../middleware/auth';
import { User } from '@prisma/client';

// Define the status route
export const statusRoute = createRoute({
  method: 'get',
  path: '/api/status',
  summary: 'Get Service Status',
  description: 'Get service status and feature availability',
  tags: ['General'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: StatusResponseSchema,
        },
      },
      description: 'Service status information',
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

// Create status router
export const statusRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth middleware
statusRouter.use('/api/status', authMiddleware);

statusRouter.openapi(statusRoute, async (c) => {
  const user = c.get('user');
  
  return c.json({
    status: 'operational',
    version: '0.1.0',
    features: {
      semanticContent: 'planned',
      collaboration: 'planned',
      rbac: 'planned',
    },
    message: 'Ready to build the future of knowledge management!',
    authenticatedAs: user?.email,
  }, 200);
});