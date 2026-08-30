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
import type { User } from '@prisma/client';
import type { components, EnvironmentConfig } from '@semiont/core';
import { kbDid } from '@semiont/core';
import { kbBranch } from '../lib/archivist';

type StatusResponse = components['schemas']['StatusResponse'];

// Create status router with plain Hono
export const statusRouter = new Hono<{ Variables: { user: User; config: EnvironmentConfig } }>();

// Apply auth middleware
statusRouter.use('/api/status', authMiddleware);

/**
 * GET /api/status
 *
 * Get service status and feature availability
 * Requires authentication
 */
statusRouter.get('/api/status', async (c) => {
  const user = c.get('user');
  const config = c.get('config');
  // Three facts about a KB tree this process does not mount (SINGLE-KB-MOUNT
  // P5). The two COMMITTED ones ride the launcher-staged `[kb]` identity card
  // — the same values the KB's own `.semiont/config` declares, which is what
  // makes the did below byte-identical to the one the launcher publishes.
  const projectName = config.kb?.name;
  // The one LIVE fact, so it comes from the process holding the tree: a
  // branch switch does not restart the stack, and a staged copy would go
  // stale silently. Absent when the Archivist cannot be reached — the field
  // is optional and a status endpoint must still answer.
  const gitBranch = await kbBranch(config);
  // The KB's own identity, so a client can tell WHICH knowledge base it just
  // connected to rather than inferring it from the address it dialed
  // (.plans/KB-IDENTITY-VS-ADDRESS.md). Read from the committed
  // `[site] domain` — the same source, and therefore byte-identical to the
  // string the launcher publishes.
  //
  // Both branches below are unreachable in a running backend: `SEMIONT_ROOT`
  // is mandatory and boot refuses a KB with no declared domain (decision 8).
  // They throw rather than fall back BECAUSE the field is required — the only
  // fallbacks available would be fabrications ('localhost', the address), and
  // a plausible wrong identity is worse than a loud failure. This is what
  // "required" costs and why it is worth paying: no caller ever has to wonder
  // whether the did they were handed was real.
  const siteDomain = config.kb?.domain;
  if (!siteDomain) {
    throw new Error(
      'KB identity unavailable: no [kb] domain in the staged config. ' +
        'Startup should have refused this — see the identity check in index.ts.',
    );
  }
  const did = kbDid(siteDomain);

  const response: StatusResponse = {
    status: 'operational',
    version: __SEMIONT_VERSION__,
    features: {
      semanticContent: 'planned',
      collaboration: 'planned',
      rbac: 'planned',
    },
    message: 'Ready to build the future of knowledge management!',
    authenticatedAs: user?.email,
    projectName,
    gitBranch: gitBranch ?? undefined,
    did,
  };

  return c.json(response, 200);
});
