// Shared imports and types for selection routes
import { OpenAPIHono } from '@hono/zod-openapi';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';

// Shared router type
export type SelectionsRouterType = OpenAPIHono<{ Variables: { user: User } }>;

// Create a router with auth middleware pre-applied
export function createSelectionRouter(): SelectionsRouterType {
  const router = new OpenAPIHono<{ Variables: { user: User } }>();
  router.use('/api/selections/*', authMiddleware);
  return router;
}