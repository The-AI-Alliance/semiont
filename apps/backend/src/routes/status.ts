import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  StatusResponseSchema as BaseStatusResponseSchema,
  ErrorResponseSchema as BaseErrorResponseSchema,
} from '@semiont/core-types';
import { authMiddleware } from '../middleware/auth';
import { User } from '@prisma/client';

// OpenAPI-wrapped schemas for this route
export const StatusResponseSchema = BaseStatusResponseSchema.extend({
  status: z.string().openapi({ example: 'operational' }),
  version: z.string().openapi({ example: '0.1.0' }),
  features: z.object({
    semanticContent: z.string(),
    collaboration: z.string(),
    rbac: z.string(),
  }).openapi({ example: { semanticContent: 'planned', collaboration: 'planned', rbac: 'planned' } }),
  message: z.string().openapi({ example: 'Ready to build the future of knowledge management!' }),
  authenticatedAs: z.string().optional().openapi({ example: 'user@example.com' }),
}).openapi('StatusResponse');

export const ErrorResponseSchema = BaseErrorResponseSchema.extend({
  error: z.string().openapi({ example: 'An error occurred' }),
  code: z.string().optional().openapi({ example: 'ERROR_CODE' }),
}).openapi('ErrorResponse');

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