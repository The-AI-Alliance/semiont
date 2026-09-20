/**
 * Authentication routes — the signed-in principal and the tokens the gateway
 * itself mints. Humans sign in at the trusted issuer; the gateway only
 * verifies their tokens (see `identity/`). Plain Hono, response types from
 * the generated OpenAPI types.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { JWTService } from '../auth/jwt';
import { authorizeAgentMinter, AgentMinterRefused } from '../identity/agent-minter';
import type { components } from '@semiont/core';
import { email as makeEmail, agentToDid } from '@semiont/core';

type UserResponse = components['schemas']['UserResponse'];

export const authRouter = new Hono();

/**
 * GET /api/users/me
 *
 * Who the bearer of this token is, as this knowledge base names them.
 *
 * The answer is the DID, taken from the context the auth middleware already
 * computed — so a software agent gets its agent DID and a person gets theirs,
 * by the same rule that decides what every event they cause is attributed to.
 *
 * What this used to return and no longer does: the User row's id, which
 * appears nowhere else in the system and so answered a question nobody could
 * act on; `provider`, `lastLogin` and `created`, which nothing read; and the
 * caller's own token, echoed back to the caller who had just sent it.
 */
authRouter.get('/api/users/me', authMiddleware, async (c) => {
  const principal = c.get('principal');

  const response: UserResponse = {
    did: principal.did,
    email: principal.email,
    name: principal.name,
    image: principal.image,
    domain: principal.domain,
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
 * with no revocation behind it: the agent identity is synthetic, so there is
 * nothing at the issuer to disable. Disabling the service account that asked
 * for it stops further mints but cannot touch a token already handed out. The
 * lifetime IS the revocation window, so it is short enough to matter and long
 * enough that re-minting stays cheap.
 */
const AGENT_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * POST /api/tokens/agent
 *
 * Software-agent token exchange. A sidecar authenticates at the trusted issuer
 * as its own service account and presents that token here, along with the
 * inference (provider, model) the agent token is being issued for.
 *
 * Two identities, deliberately: the service account is the PROCESS, and the
 * agent DID is the WORK. One worker process holds several agent identities at
 * once when a deployment configures different models for different job types,
 * so the caller's credential cannot be the agent's identity.
 *
 * The agent's DID has the shape `did:web:<host>:agents:<provider>:<model>`
 * (see `agentToDid` in @semiont/core). It is what the bus stamps onto
 * `_userId` on every event the worker emits — so events the agent
 * produces attribute to the agent, not to a generic worker pool.
 */
authRouter.post('/api/tokens/agent', async (c) => {
  let minter: string;
  try {
    minter = await authorizeAgentMinter(c.req.header('Authorization'));
  } catch (error) {
    if (error instanceof AgentMinterRefused) {
      return c.json({ error: error.message }, 401);
    }
    throw error;
  }

  let body: { provider?: string; model?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
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

  // The agent's synthetic address, derived so that the same (provider, model)
  // always names the same agent. It lives in a dedicated `agents.<host>`
  // namespace so it cannot collide with a real person on the deployment
  // domain. The site domain may carry a port (e.g. `localhost:8080`) — fine in
  // a DID, but an email has to satisfy RFC-5321 host syntax, so strip it here.
  const emailHost = siteDomain.split(':')[0]!;
  const providerId = `${inferenceProvider}:${model}`;
  const slug = providerId.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const agentEmail = `${slug}@agents.${emailHost}`;
  const agentName = `${inferenceProvider} ${model}`;

  const did = agentToDid({ domain: siteDomain, provider: inferenceProvider, model });

  // Which service account asked for which agent identity. Worth a line: the two
  // are deliberately different, so an operator tracing an event back to its
  // agent DID otherwise has no record of which process requested it.
  c.get('logger')?.info('Agent token issued', { minter, did });

  // No row is written. The agent's identity IS the DID, derived from the same
  // (domain, provider, model) the caller just presented, so there was never a
  // fact here for a database to remember — the synthetic row this replaces
  // existed only to hand out a cuid that nothing downstream read.
  const token = JWTService.generateToken({
    did,
    email: makeEmail(agentEmail),
    name: agentName,
    domain: siteDomain,
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
  let body: { resourceId: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  if (!body.resourceId || typeof body.resourceId !== 'string') {
    return c.json({ error: 'resourceId is required' }, 400);
  }
  const token = JWTService.generateMediaToken(body.resourceId);
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
  const principal = c.get('principal');

  const exportData = {
    user: {
      did: principal.did,
      email: principal.email,
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
