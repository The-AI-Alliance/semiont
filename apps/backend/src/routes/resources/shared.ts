// Shared imports and types for resource routes
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';
import type { EventBus } from '@semiont/core';
import type { startMakeMeaning } from '@semiont/make-meaning';

// Shared router type
export type ResourcesRouterType = Hono<{ Variables: { user: User; principalDid: string; agentDid?: string; eventBus: EventBus; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>;

// Create a router with auth middleware pre-applied
export function createResourceRouter(): ResourcesRouterType {
  const router = new Hono<{ Variables: { user: User; principalDid: string; agentDid?: string; eventBus: EventBus; makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>> } }>();
  router.use('/api/resources/*', authMiddleware);
  router.use('/api/clone-tokens/*', authMiddleware);
  router.use('/resources/*', authMiddleware); // W3C URI endpoints also require auth
  // The anchored-text keys listing lives outside /resources/* (it is a
  // store-level read, not resource-scoped) but carries the same contract:
  // 401 without auth first, then the route's own agent-only 403.
  router.use('/anchored-text/*', authMiddleware);
  return router;
}