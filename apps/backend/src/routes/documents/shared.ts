// Shared imports and types for document routes
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';

// Shared router type
export type DocumentsRouterType = Hono<{ Variables: { user: User } }>;

// Create a router with auth middleware pre-applied
export function createDocumentRouter(): DocumentsRouterType {
  const router = new Hono<{ Variables: { user: User } }>();
  router.use('/api/documents/*', authMiddleware);
  return router;
}