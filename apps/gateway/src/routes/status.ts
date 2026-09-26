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
import type { components, EnvironmentConfig } from '@semiont/core';

type StatusResponse = components['schemas']['StatusResponse'];

// Create status router with plain Hono
export const statusRouter = new Hono<{ Variables: { config: EnvironmentConfig } }>();

// Apply auth middleware
statusRouter.use('/api/status', authMiddleware);

/**
 * GET /api/status
 *
 * Get service status and feature availability
 * Requires authentication
 */
statusRouter.get('/api/status', async (c) => {
  const principal = c.get('principal');
  // The gateway reports itself. What a knowledge base is — its name, its
  // domain, its branch — the Archivist answers over the bus (`browse:kb`),
  // so this route asks nothing of another service.
  const response: StatusResponse = {
    status: 'operational',
    version: __SEMIONT_VERSION__,
    features: {
      semanticContent: 'planned',
      collaboration: 'planned',
      rbac: 'planned',
    },
    message: 'Ready to build the future of knowledge management!',
    authenticatedAs: principal?.email,
  };

  return c.json(response, 200);
});
