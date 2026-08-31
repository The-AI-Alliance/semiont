// Shared imports and types for resource routes
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';
import type { EnvironmentConfig, EventBus } from '@semiont/core';

// The context these routes read. `config` and `eventBus` are set by the
// global middleware in index.ts; the rest by authMiddleware below.
// Named once — the router type and the constructor below both refer to it,
// rather than restating it and drifting.
type ResourceVariables = {
  user: User;
  principalDid: string;
  agentDid?: string;
  eventBus: EventBus;
  config: EnvironmentConfig;
};

// Shared router type
export type ResourcesRouterType = Hono<{ Variables: ResourceVariables }>;

// Create a router with auth middleware pre-applied
export function createResourceRouter(): ResourcesRouterType {
  const router = new Hono<{ Variables: ResourceVariables }>();
  router.use('/api/resources/*', authMiddleware);
  router.use('/api/clone-tokens/*', authMiddleware);
  router.use('/resources/*', authMiddleware); // W3C URI endpoints also require auth
  return router;
}