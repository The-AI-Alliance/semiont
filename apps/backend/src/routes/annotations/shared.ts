// Shared imports and types for annotation routes
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';
import type { EnvironmentConfig } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';

// Shared router type
export type AnnotationsRouterType = Hono<{ Variables: { user: User; config: EnvironmentConfig; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>;

// Create a router with auth middleware pre-applied
export function createAnnotationRouter(): AnnotationsRouterType {
  const router = new Hono<{ Variables: { user: User; config: EnvironmentConfig; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>();
  router.use('/api/annotations/*', authMiddleware);
  router.use('/annotations/*', authMiddleware); // W3C URI endpoints also require auth
  return router;
}