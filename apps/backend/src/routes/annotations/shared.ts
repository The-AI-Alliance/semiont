// Shared imports and types for annotation routes
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';
import type { EnvironmentConfig } from '@semiont/core';

// Shared router type
export type AnnotationsRouterType = Hono<{ Variables: { user: User; config: EnvironmentConfig } }>;

// Create a router with auth middleware pre-applied
export function createAnnotationRouter(): AnnotationsRouterType {
  const router = new Hono<{ Variables: { user: User; config: EnvironmentConfig } }>();
  router.use('/api/annotations/*', authMiddleware);
  router.use('/annotations/*', authMiddleware); // W3C URI endpoints also require auth
  return router;
}