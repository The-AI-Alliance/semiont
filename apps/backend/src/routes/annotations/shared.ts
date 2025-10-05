// Shared imports and types for annotation routes
import { OpenAPIHono } from '@hono/zod-openapi';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';

// Shared router type
export type AnnotationsRouterType = OpenAPIHono<{ Variables: { user: User } }>;

// Create a router with auth middleware pre-applied
export function createAnnotationRouter(): AnnotationsRouterType {
  const router = new OpenAPIHono<{ Variables: { user: User } }>();
  router.use('/api/annotations/*', authMiddleware);
  return router;
}