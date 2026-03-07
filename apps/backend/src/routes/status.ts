/**
 * Status Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No request validation needed (GET endpoint)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import type { User } from '@prisma/client';
import type { components } from '@semiont/core';

type StatusResponse = components['schemas']['StatusResponse'];

// Create status router with plain Hono
export const statusRouter = new Hono<{ Variables: { user: User } }>();

// Apply auth middleware
statusRouter.use('/api/status', authMiddleware);

/**
 * GET /api/status
 *
 * Get service status and feature availability
 * Requires authentication
 */
statusRouter.get('/api/status', async (c) => {
  const user = c.get('user');

  const response: StatusResponse = {
    status: 'operational',
    version: '0.1.0',
    features: {
      semanticContent: 'planned',
      collaboration: 'planned',
      rbac: 'planned',
    },
    message: 'Ready to build the future of knowledge management!',
    authenticatedAs: user?.email,
  };

  return c.json(response, 200);
});
