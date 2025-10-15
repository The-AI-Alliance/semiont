import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  UserListResponseSchema,
  UserStatsResponseSchema,
  UpdateUserRequestSchema,
  UpdateUserResponseSchema,
  DeleteUserResponseSchema,
  OAuthConfigResponseSchemaActual,
  type UpdateUserResponse,
  type DeleteUserResponse,
  type OAuthConfigResponseActual,
} from '@semiont/sdk';
import { ErrorResponseSchema } from '../openapi';
import { authMiddleware } from '../middleware/auth';
import { DatabaseConnection } from '../db';
import { User } from '@prisma/client';

// Admin middleware to check admin privileges
const adminMiddleware = async (c: any, next: any) => {
  const user = c.get('user');

  if (!user || !user.isAdmin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }

  return next();
};

// List users route
export const listUsersRoute = createRoute({
  method: 'get',
  path: '/api/admin/users',
  summary: 'List All Users',
  description: 'Get a list of all users (admin only)',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: UserListResponseSchema as any,
        },
      },
      description: 'List of users',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Forbidden - Admin access required',
    },
  },
});

// User stats route
export const userStatsRoute = createRoute({
  method: 'get',
  path: '/api/admin/users/stats',
  summary: 'User Statistics',
  description: 'Get user statistics (admin only)',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: UserStatsResponseSchema as any,
        },
      },
      description: 'User statistics',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Forbidden - Admin access required',
    },
  },
});

// Update user route
export const updateUserRoute = createRoute({
  method: 'patch',
  path: '/api/admin/users/{id}',
  summary: 'Update User',
  description: 'Update user properties (admin only)',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({
        param: {
          name: 'id',
          in: 'path',
        },
        example: 'user-123',
      }),
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateUserRequestSchema as any,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: UpdateUserResponseSchema as any,
        },
      },
      description: 'User updated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Invalid request',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Forbidden - Admin access required',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'User not found',
    },
  },
});

// OAuth config route
export const oauthConfigRoute = createRoute({
  method: 'get',
  path: '/api/admin/oauth/config',
  summary: 'Get OAuth Configuration',
  description: 'Get OAuth provider configuration (admin only, read-only)',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: OAuthConfigResponseSchemaActual as any,
        },
      },
      description: 'OAuth configuration',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Forbidden - Admin access required',
    },
  },
});

// Delete user route
export const deleteUserRoute = createRoute({
  method: 'delete',
  path: '/api/admin/users/{id}',
  summary: 'Delete User',
  description: 'Delete a user account (admin only, cannot delete own account)',
  tags: ['Admin'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({
        param: {
          name: 'id',
          in: 'path',
        },
        example: 'user-123',
      }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DeleteUserResponseSchema as any,
        },
      },
      description: 'User deleted successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Cannot delete own account',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Unauthorized',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Forbidden - Admin access required',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'User not found',
    },
  },
});

// Create admin router
export const adminRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth and admin middleware to all admin routes
adminRouter.use('/api/admin/*', authMiddleware, adminMiddleware);

// List users
adminRouter.openapi(listUsersRoute, async (c) => {
  const prisma = DatabaseConnection.getClient();
  
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      domain: true,
      provider: true,
      isAdmin: true,
      isActive: true,
      termsAcceptedAt: true,
      lastLogin: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  
  return c.json({
    success: true,
    users: users.map((u) => ({
      ...u,
      termsAcceptedAt: u.termsAcceptedAt?.toISOString() || null,
      lastLogin: u.lastLogin?.toISOString() || null,
      created: u.createdAt.toISOString(),
      updatedAt: u.updatedAt.toISOString(),
    })),
  }, 200);
});

// User statistics
adminRouter.openapi(userStatsRoute, async (c) => {
  const prisma = DatabaseConnection.getClient();
  
  const [totalUsers, activeUsers, adminUsers, domainStats, recentUsers] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.user.count({ where: { isAdmin: true } }),
    prisma.user.groupBy({
      by: ['domain'],
      _count: { domain: true },
      orderBy: { _count: { domain: 'desc' } },
    }),
    prisma.user.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  
  return c.json({
    success: true,
    stats: {
      totalUsers,
      activeUsers,
      adminUsers,
      regularUsers: totalUsers - adminUsers,
      domainBreakdown: domainStats.map((d) => ({
        domain: d.domain,
        count: d._count.domain,
      })),
      recentSignups: recentUsers.map((u) => ({
        ...u,
        created: u.createdAt.toISOString(),
      })),
    },
  }, 200);
});

// Update user
adminRouter.openapi(updateUserRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = await c.req.valid('json');
  const prisma = DatabaseConnection.getClient();
  
  // Check if user exists
  const existingUser = await prisma.user.findUnique({
    where: { id },
  });
  
  if (!existingUser) {
    return c.json({ error: 'User not found' }, 404);
  }
  
  // Update user
  const updatedUser = await prisma.user.update({
    where: { id },
    data: {
      ...(body.isAdmin !== undefined && { isAdmin: body.isAdmin }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.name !== undefined && { name: body.name }),
    },
  });

  const response: UpdateUserResponse = {
    success: true,
    user: {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      image: updatedUser.image,
      domain: updatedUser.domain,
      provider: updatedUser.provider,
      isAdmin: updatedUser.isAdmin,
      isActive: updatedUser.isActive,
      lastLogin: updatedUser.lastLogin?.toISOString() || null,
      created: updatedUser.createdAt.toISOString(),
      updatedAt: updatedUser.updatedAt.toISOString(),
    },
  };

  return c.json(response, 200);
});

// Delete user
adminRouter.openapi(deleteUserRoute, async (c) => {
  const { id } = c.req.valid('param');
  const currentUser = c.get('user');
  const prisma = DatabaseConnection.getClient();
  
  // Cannot delete own account
  if (id === currentUser.id) {
    return c.json({ error: 'Cannot delete your own account' }, 400);
  }
  
  // Check if user exists
  const existingUser = await prisma.user.findUnique({
    where: { id },
  });
  
  if (!existingUser) {
    return c.json({ error: 'User not found' }, 404);
  }
  
  // Delete user
  await prisma.user.delete({
    where: { id },
  });

  const response: DeleteUserResponse = {
    success: true,
    message: `User ${existingUser.email} deleted successfully`,
  };

  return c.json(response, 200);
});

// OAuth configuration
adminRouter.openapi(oauthConfigRoute, async (c) => {
  // Get OAuth configuration from environment
  const allowedDomainsEnv = process.env.OAUTH_ALLOWED_DOMAINS;
  if (!allowedDomainsEnv) {
    throw new Error('OAUTH_ALLOWED_DOMAINS environment variable is not configured');
  }

  const allowedDomains = allowedDomainsEnv
    .split(',')
    .map(d => d.trim())
    .filter(d => d.length > 0);
  
  // Check which providers are configured
  const providers = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push({
      name: 'google',
      isConfigured: true,
      clientId: process.env.GOOGLE_CLIENT_ID.substring(0, 20) + '...'
    });
  }

  const response: OAuthConfigResponseActual = {
    providers,
    allowedDomains
  };

  return c.json(response, 200);
});