// Shared imports and types for resource routes
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';
import type { EnvironmentConfig } from '@semiont/core';

// Shared router type
export type ResourcesRouterType = Hono<{ Variables: { user: User; config: EnvironmentConfig } }>;

// Create a router with auth middleware pre-applied
export function createResourceRouter(): ResourcesRouterType {
  const router = new Hono<{ Variables: { user: User; config: EnvironmentConfig } }>();
  router.use('/api/resources/*', authMiddleware);
  router.use('/resources/*', authMiddleware); // W3C URI endpoints also require auth
  return router;
}