/**
 * Authentication routes — the signed-in principal and the tokens the gateway
 * itself mints. Humans sign in at the trusted issuer; the gateway only
 * verifies their tokens (see `identity/`). Plain Hono, response types from
 * the generated OpenAPI types.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { DatabaseConnection } from '../db';
import { JWTService } from '../auth/jwt';
import type { User } from '@prisma/client';
import type { components } from '@semiont/core';
import { userId as makeUserId, email as makeEmail, agentToDid } from '@semiont/core';

type UserResponse = components['schemas']['UserResponse'];

export const authRouter = new Hono<{ Variables: { user: User; token: string } }>();

/**
 * GET /api/users/me
 *
 * Get Current User - Get information about the authenticated user
 * Requires authentication
 * Response type: UserResponse from OpenAPI spec
 */
authRouter.get('/api/users/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const token = c.get('token');

  const response: UserResponse = {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    domain: user.domain,
    provider: user.provider,
    isAdmin: user.isAdmin,
    isModerator: user.isModerator,
    lastLogin: user.lastLogin?.toISOString() || null,
    created: user.createdAt.toISOString(),
    token,
  };

  return c.json(response, 200);
});


/**
 * How long a software-agent token lives, in seconds.
 *
 * This is the ONLY place the lifetime is decided. It is signed into the token
 * and nowhere else: a long-lived agent schedules its re-authentication by
 * reading the `exp` claim off the token it was handed, so there is no second
 * copy of this number to drift. Four sidecars used to hold such a copy, as
 * `12 * 60 * 60 * 1000`, "half the TTL" of a value they did not own.
 *
 * An hour rather than a day because an agent token is the one credential here
 * with no revocation behind it: the account is synthetic, so there is nothing
 * at the issuer to disable, and rotating the shared secret stops new mints
 * without touching tokens already handed out. The lifetime IS the revocation
 * window, so it is short enough to matter and long enough that re-minting
 * stays cheap.
 */
const AGENT_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * POST /api/tokens/agent
 *
 * Software-agent token exchange. A worker process presents the shared
 * `SEMIONT_WORKER_SECRET` along with the inference (provider, model)
 * the token is being issued for. The gateway upserts a User row that
 * backs the agent identity and returns a JWT carrying both the
 * synthetic User and the agent's DID.
 *
 * The agent's DID has the shape `did:web:<host>:agents:<provider>:<model>`
 * (see `agentToDid` in @semiont/core). It is what the bus stamps onto
 * `_userId` on every event the worker emits — so events the agent
 * produces attribute to the agent, not to a generic worker pool.
 *
 * Public endpoint (no authentication required — this IS the auth step).
 */
authRouter.post('/api/tokens/agent', async (c) => {
  const workerSecret = process.env.SEMIONT_WORKER_SECRET;
  if (!workerSecret) {
    return c.json({ error: 'Agent authentication not configured' }, 503);
  }

  let body: { secret?: string; provider?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  if (body.secret !== workerSecret) {
    return c.json({ error: 'Invalid agent secret' }, 401);
  }
  if (!body.provider || typeof body.provider !== 'string') {
    return c.json({ error: 'provider is required' }, 400);
  }
  if (!body.model || typeof body.model !== 'string') {
    return c.json({ error: 'model is required' }, 400);
  }

  const inferenceProvider = body.provider;
  const model = body.model;

  // The deployment domain is the issuer of the agent's DID. JWTService
  // already validates `domain` is set in env config; reuse it here.
  const siteDomain = JWTService.getDomainForAgent();

  // Synthetic User row backing the agent identity. Keyed by
  // (provider='agent', providerId='<provider>:<model>') so each
  // (provider, model) pair gets a stable User row that's auto-upserted
  // on first use. The email is a deterministic identifier in a
  // dedicated `agents.<host>` namespace so it can't collide with real
  // users on the deployment domain.
  //
  // The site domain may carry a port (e.g. `localhost:8080`) — that's
  // fine in a DID, but the synthetic email has to satisfy RFC-5321
  // host syntax (no colons), so strip it here.
  const emailHost = siteDomain.split(':')[0]!;
  const providerId = `${inferenceProvider}:${model}`;
  const slug = providerId.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const agentEmail = `${slug}@agents.${emailHost}`;
  const agentName = `${inferenceProvider} ${model}`;

  const prisma = DatabaseConnection.getClient();
  const agentUser = await prisma.user.upsert({
    where: { provider_providerId: { provider: 'agent', providerId } },
    update: {
      name: agentName,
      lastLogin: new Date(),
    },
    create: {
      email: agentEmail,
      name: agentName,
      provider: 'agent',
      providerId,
      domain: siteDomain,
      isAdmin: false,
    },
  });

  const did = agentToDid({ domain: siteDomain, provider: inferenceProvider, model });

  const token = JWTService.generateToken({
    userId: makeUserId(agentUser.id),
    email: makeEmail(agentUser.email),
    name: agentUser.name ?? agentName,
    domain: agentUser.domain,
    provider: agentUser.provider,
    isAdmin: false,
    agentDid: did,
  }, `${AGENT_TOKEN_TTL_SECONDS}s`);

  return c.json({ token, did }, 200);
});

/**
 * POST /api/tokens/media
 *
 * Generate a short-lived, resource-scoped media token.
 * Used by the frontend to authenticate binary resource fetches (images, PDFs)
 * via ?token= query parameter without exposing the session JWT in URLs.
 */
authRouter.post('/api/tokens/media', authMiddleware, async (c) => {
  const user = c.get('user');
  let body: { resourceId: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  if (!body.resourceId || typeof body.resourceId !== 'string') {
    return c.json({ error: 'resourceId is required' }, 400);
  }
  const token = JWTService.generateMediaToken(body.resourceId, user.id);
  return c.json({ token }, 200);
});

/**
 * GET /api/cookies/consent
 *
 * Get current user's cookie consent preferences.
 * Requires authentication.
 */
authRouter.get('/api/cookies/consent', authMiddleware, async (c) => {
  return c.json({
    success: true,
    consent: {
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: new Date().toISOString(),
      version: '1.0'
    }
  });
});

/**
 * POST /api/cookies/consent
 *
 * Update user's cookie consent preferences.
 * Requires authentication.
 */
authRouter.post('/api/cookies/consent', authMiddleware, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }

  if (typeof body.necessary !== 'boolean' ||
      typeof body.analytics !== 'boolean' ||
      typeof body.marketing !== 'boolean' ||
      typeof body.preferences !== 'boolean') {
    return c.json({ success: false, error: 'Invalid consent data' }, 400);
  }

  if (!body.necessary) {
    return c.json({ success: false, error: 'Necessary cookies cannot be disabled' }, 400);
  }

  return c.json({
    success: true,
    consent: {
      necessary: body.necessary,
      analytics: body.analytics,
      marketing: body.marketing,
      preferences: body.preferences,
      timestamp: new Date().toISOString(),
      version: '1.0'
    }
  });
});

/**
 * GET /api/cookies/export
 *
 * Export user's cookie data for GDPR compliance.
 * Requires authentication.
 */
authRouter.get('/api/cookies/export', authMiddleware, async (c) => {
  const user = c.get('user');

  const exportData = {
    user: {
      id: user.id,
      email: user.email,
    },
    consent: {
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: new Date().toISOString(),
      version: '1.0'
    },
    exportDate: new Date().toISOString(),
    dataRetentionPolicy: 'Cookie consent data is retained for 2 years from last update or until explicitly withdrawn.'
  };

  c.header('Content-Disposition', `attachment; filename="cookie-data-export-${Date.now()}.json"`);
  return c.json(exportData);
});
