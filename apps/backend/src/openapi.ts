import { z } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';

// Re-export our existing schemas but with OpenAPI metadata
export const HelloResponseSchema = z.object({
  message: z.string().openapi({ example: 'Hello, World! Welcome to Semiont.' }),
  timestamp: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  platform: z.string().openapi({ example: 'Semiont Semantic Knowledge Platform' }),
  user: z.string().optional().openapi({ example: 'user@example.com' }),
}).openapi('HelloResponse');

export const StatusResponseSchema = z.object({
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

export const HealthResponseSchema = z.object({
  status: z.string().openapi({ example: 'operational' }),
  message: z.string().openapi({ example: 'Semiont API is running' }),
  version: z.string().openapi({ example: '0.1.0' }),
  timestamp: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  database: z.enum(['connected', 'disconnected', 'unknown']).openapi({ example: 'connected' }),
  environment: z.string().openapi({ example: 'development' }),
}).openapi('HealthResponse');

export const GoogleAuthRequestSchema = z.object({
  access_token: z.string().openapi({ 
    example: 'ya29.a0AfH6SMBx...', 
    description: 'Google OAuth access token'
  }),
}).openapi('GoogleAuthRequest');

export const AuthResponseSchema = z.object({
  success: z.boolean(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    domain: z.string(),
    isAdmin: z.boolean(),
  }),
  token: z.string().openapi({ description: 'JWT token for API authentication' }),
  isNewUser: z.boolean(),
}).openapi('AuthResponse');

export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  domain: z.string(),
  provider: z.string(),
  isAdmin: z.boolean(),
  isActive: z.boolean(),
  termsAcceptedAt: z.string().nullable(),
  lastLogin: z.string().nullable(),
  createdAt: z.string(),
}).openapi('UserResponse');

export const ErrorResponseSchema = z.object({
  error: z.string().openapi({ example: 'An error occurred' }),
  code: z.string().optional().openapi({ example: 'ERROR_CODE' }),
  details: z.any().optional(),
}).openapi('ErrorResponse');

export const UserListResponseSchema = z.object({
  success: z.boolean(),
  users: z.array(z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    domain: z.string(),
    provider: z.string(),
    isAdmin: z.boolean(),
    isActive: z.boolean(),
    lastLogin: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
}).openapi('UserListResponse');

export const UserStatsResponseSchema = z.object({
  success: z.boolean(),
  stats: z.object({
    total: z.number(),
    active: z.number(),
    admins: z.number(),
    recent: z.number(),
  }),
}).openapi('UserStatsResponse');

export const UpdateUserRequestSchema = z.object({
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
  name: z.string().optional(),
}).openapi('UpdateUserRequest');

// Create route definitions for OpenAPI documentation
export const routes = {
  health: createRoute({
    method: 'get',
    path: '/api/health',
    summary: 'Health Check',
    description: 'Check API health and database connectivity',
    tags: ['Monitoring'],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: HealthResponseSchema,
          },
        },
        description: 'API is healthy',
      },
    },
  }),

  apiDocs: createRoute({
    method: 'get',
    path: '/api',
    summary: 'API Documentation',
    description: 'Get API documentation in JSON or HTML format',
    tags: ['Documentation'],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.any(),
          },
          'text/html': {
            schema: z.string(),
          },
        },
        description: 'API documentation',
      },
    },
  }),

  hello: createRoute({
    method: 'get',
    path: '/api/hello/{name}',
    summary: 'Hello Endpoint',
    description: 'Get a personalized greeting (requires authentication)',
    tags: ['General'],
    security: [{ BearerAuth: [] }],
    request: {
      params: z.object({
        name: z.string().optional().openapi({ example: 'World' }),
      }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: HelloResponseSchema,
          },
        },
        description: 'Personalized greeting',
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
  }),

  status: createRoute({
    method: 'get',
    path: '/api/status',
    summary: 'Service Status',
    description: 'Get service status and feature availability (requires authentication)',
    tags: ['General'],
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: StatusResponseSchema,
          },
        },
        description: 'Service status',
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
  }),

  authGoogle: createRoute({
    method: 'post',
    path: '/api/auth/google',
    summary: 'Google OAuth Authentication',
    description: 'Authenticate with Google OAuth and receive JWT token',
    tags: ['Authentication'],
    request: {
      body: {
        content: {
          'application/json': {
            schema: GoogleAuthRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: AuthResponseSchema,
          },
        },
        description: 'Authentication successful',
      },
      400: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Invalid request or authentication failed',
      },
    },
  }),

  authMe: createRoute({
    method: 'get',
    path: '/api/auth/me',
    summary: 'Get Current User',
    description: 'Get current authenticated user information',
    tags: ['Authentication'],
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: UserResponseSchema,
          },
        },
        description: 'Current user information',
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
  }),

  authLogout: createRoute({
    method: 'post',
    path: '/api/auth/logout',
    summary: 'Logout',
    description: 'Logout (stateless - client should discard token)',
    tags: ['Authentication'],
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              message: z.string(),
            }),
          },
        },
        description: 'Logout successful',
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
  }),

  adminUsers: createRoute({
    method: 'get',
    path: '/api/admin/users',
    summary: 'List Users',
    description: 'List all users (admin only)',
    tags: ['Admin'],
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: UserListResponseSchema,
          },
        },
        description: 'List of users',
      },
      401: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Unauthorized',
      },
      403: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Forbidden - Admin access required',
      },
    },
  }),

  adminUserStats: createRoute({
    method: 'get',
    path: '/api/admin/users/stats',
    summary: 'User Statistics',
    description: 'Get user statistics (admin only)',
    tags: ['Admin'],
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: UserStatsResponseSchema,
          },
        },
        description: 'User statistics',
      },
      401: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Unauthorized',
      },
      403: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Forbidden - Admin access required',
      },
    },
  }),

  adminUpdateUser: createRoute({
    method: 'patch',
    path: '/api/admin/users/{id}',
    summary: 'Update User',
    description: 'Update user properties (admin only)',
    tags: ['Admin'],
    security: [{ BearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().openapi({ example: 'user-id' }),
      }),
      body: {
        content: {
          'application/json': {
            schema: UpdateUserRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              user: z.object({
                id: z.string(),
                email: z.string(),
                name: z.string().nullable(),
                image: z.string().nullable(),
                domain: z.string(),
                provider: z.string(),
                isAdmin: z.boolean(),
                isActive: z.boolean(),
                lastLogin: z.string().nullable(),
                createdAt: z.string(),
                updatedAt: z.string(),
              }),
            }),
          },
        },
        description: 'User updated successfully',
      },
      401: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Unauthorized',
      },
      403: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Forbidden - Admin access required',
      },
      404: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'User not found',
      },
    },
  }),

  adminDeleteUser: createRoute({
    method: 'delete',
    path: '/api/admin/users/{id}',
    summary: 'Delete User',
    description: 'Delete user account (admin only, cannot delete own account)',
    tags: ['Admin'],
    security: [{ BearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().openapi({ example: 'user-id' }),
      }),
    },
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              message: z.string(),
            }),
          },
        },
        description: 'User deleted successfully',
      },
      400: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Cannot delete own account',
      },
      401: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Unauthorized',
      },
      403: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'Forbidden - Admin access required',
      },
      404: {
        content: {
          'application/json': {
            schema: ErrorResponseSchema,
          },
        },
        description: 'User not found',
      },
    },
  }),
};

// OpenAPI configuration
export const openApiConfig = {
  openapi: '3.0.0',
  info: {
    title: 'Semiont API',
    version: '0.1.0',
    description: 'REST API for the Semiont Semantic Knowledge Platform',
    contact: {
      name: 'Semiont Team',
      email: 'support@semiont.com',
    },
  },
  servers: [
    {
      url: 'http://localhost:4000',
      description: 'Development server',
    },
    {
      url: 'http://localhost:3001',
      description: 'Local development server',
    },
    {
      url: 'https://api.semiont.com',
      description: 'Production server',
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT Bearer token authentication',
      },
    },
  },
  tags: [
    {
      name: 'Monitoring',
      description: 'Health and monitoring endpoints',
    },
    {
      name: 'Documentation',
      description: 'API documentation endpoints',
    },
    {
      name: 'General',
      description: 'General API endpoints',
    },
    {
      name: 'Authentication',
      description: 'Authentication and authorization endpoints',
    },
    {
      name: 'Admin',
      description: 'Admin-only endpoints for user management',
    },
  ],
};