/**
 * Admin Routes - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request bodies with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { DatabaseConnection } from '../db';
import { User } from '@prisma/client';
import { validateRequestBody } from '../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

type UpdateUserRequest = components['schemas']['UpdateUserRequest'];
type UpdateUserResponse = components['schemas']['UpdateUserResponse'];
type DeleteUserResponse = components['schemas']['DeleteUserResponse'];
type OAuthConfigResponseActual = components['schemas']['OAuthConfigResponse'];

// Admin middleware to check admin privileges
const adminMiddleware = async (c: any, next: any) => {
  const user = c.get('user');

  if (!user || !user.isAdmin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }

  return next();
};

// Create admin router
export const adminRouter = new Hono<{ Variables: { user: User } }>();

// Apply auth and admin middleware to all admin routes
adminRouter.use('/api/admin/*', authMiddleware, adminMiddleware);

/**
 * GET /api/admin/users
 *
 * Get a list of all users (admin only)
 * Requires authentication + admin role
 */
adminRouter.get('/api/admin/users', async (c) => {
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

/**
 * GET /api/admin/users/stats
 *
 * Get user statistics (admin only)
 * Requires authentication + admin role
 */
adminRouter.get('/api/admin/users/stats', async (c) => {
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

/**
 * PATCH /api/admin/users/:id
 *
 * Update user properties (admin only)
 * Requires authentication + admin role
 */
adminRouter.patch('/api/admin/users/:id',
  validateRequestBody('UpdateUserRequest'),
  async (c) => {
    const { id } = c.req.param();
    const body = c.get('validatedBody') as UpdateUserRequest;
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
  }
);

/**
 * DELETE /api/admin/users/:id
 *
 * Delete a user account (admin only, cannot delete own account)
 * Requires authentication + admin role
 */
adminRouter.delete('/api/admin/users/:id', async (c) => {
  const { id } = c.req.param();
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

/**
 * GET /api/admin/oauth/config
 *
 * Get OAuth provider configuration (admin only, read-only)
 * Requires authentication + admin role
 */
adminRouter.get('/api/admin/oauth/config', async (c) => {
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
