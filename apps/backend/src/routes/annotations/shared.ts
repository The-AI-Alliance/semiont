// Shared imports and types for annotation routes
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';

// Shared router type
export type AnnotationsRouterType = Hono<{ Variables: { user: User } }>;

// Create a router with auth middleware pre-applied
export function createAnnotationRouter(): AnnotationsRouterType {
  const router = new Hono<{ Variables: { user: User } }>();
  router.use('/api/annotations/*', authMiddleware);
  return router;
}