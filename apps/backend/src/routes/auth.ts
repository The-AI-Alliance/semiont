/**
 * Authentication Routes - Spec-First Version (Proof of Concept)
 *
 * This demonstrates the new spec-first architecture with:
 * - Plain Hono (no @hono/zod-openapi)
 * - Ajv validation middleware (validates against OpenAPI schemas)
 * - Types from generated OpenAPI types
 * - OpenAPI spec as source of truth
 */

import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { validateRequestBody } from '../middleware/validate-openapi';
import { authMiddleware } from '../middleware/auth';
import { DatabaseConnection } from '../db';
import { JWTService } from '../auth/jwt';
import { OAuthService } from '../auth/oauth';
import * as argon2 from 'argon2';
import type { User } from '@prisma/client';
import type { JWTPayload as ValidatedJWTPayload } from '../types/jwt-types';
import type { components } from '@semiont/core';
import { userId as makeUserId, googleCredential, email as makeEmail, agentToDid } from '@semiont/core';
import { getLogger } from '../logger';
import { createSafeLogContext } from '../utils/log-sanitizer';

// Lazy initialization to avoid calling getLogger() at module load time
const getRouteLogger = () => getLogger().child({ component: 'auth' });

// Types from OpenAPI spec (generated)
type PasswordAuthRequest = components['schemas']['PasswordAuthRequest'];
type GoogleAuthRequest = components['schemas']['GoogleAuthRequest'];
type TokenRefreshRequest = components['schemas']['TokenRefreshRequest'];
type AuthResponse = components['schemas']['AuthResponse'];
type TokenRefreshResponse = components['schemas']['TokenRefreshResponse'];
type UserResponse = components['schemas']['UserResponse'];
type AcceptTermsResponse = components['schemas']['AcceptTermsResponse'];

// Create auth router with plain Hono
export const authRouter = new Hono<{ Variables: { user: User; validatedBody: unknown; token: string } }>();

/**
 * POST /api/tokens/password
 *
 * Password Authentication
 * Authenticate with email and password
 *
 * Request validation: Uses validateRequestBody middleware with 'PasswordAuthRequest' schema
 * Response type: AuthResponse from OpenAPI spec
 */
authRouter.post('/api/tokens/password',
  validateRequestBody('PasswordAuthRequest'),
  async (c) => {
    try {
      const body = c.get('validatedBody') as PasswordAuthRequest;
      const { email, password } = body;

      getRouteLogger().debug('Password auth attempt', { email });

      // Get user from database by email
      const prisma = DatabaseConnection.getClient();
      const user = await prisma.user.findUnique({
        where: { email }
      });

      // Return same error for user not found and wrong password (security)
      if (!user) {
        getRouteLogger().debug('Password auth failed: user not found', { email });
        return c.json({
          error: 'Invalid credentials'
        }, 401);
      }

      getRouteLogger().debug('User found', createSafeLogContext({
        email,
        provider: user.provider,
        isActive: user.isActive,
        hasPasswordHash: !!user.passwordHash
      }));

      // Verify user is password provider
      if (user.provider !== 'password') {
        getRouteLogger().debug('Password auth failed: wrong provider', {
          email,
          provider: user.provider
        });
        return c.json({
          error: 'This account uses OAuth. Please sign in with Google.'
        }, 400);
      }

      // Verify password hash exists
      if (!user.passwordHash) {
        getRouteLogger().debug('Password auth failed: no password hash', { email });
        return c.json({
          error: 'Password not set for this account'
        }, 400);
      }

      // Verify password
      const isValid = await argon2.verify(user.passwordHash, password);
      if (!isValid) {
        getRouteLogger().debug('Password auth failed: invalid password', { email });
        return c.json({
          error: 'Invalid credentials'
        }, 401);
      }

      // Check if user is active
      if (!user.isActive) {
        getRouteLogger().debug('Password auth failed: inactive account', { email });
        return c.json({
          error: 'Account is not active'
        }, 403);
      }

      getRouteLogger().debug('Password auth successful', { email });

      // Generate access (1h) and refresh (30d) tokens
      const jwtPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
        userId: makeUserId(user.id),
        email: makeEmail(user.email),
        ...(user.name && { name: user.name }),
        domain: user.domain,
        provider: user.provider,
        isAdmin: user.isAdmin,
        tokenVersion: user.tokenVersion,
      };

      const token = JWTService.generateToken(jwtPayload, '10m');
      const refreshToken = JWTService.generateToken(jwtPayload, '30d');

      // Update last login
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() }
      });

      setCookie(c, 'semiont-token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/',
        maxAge: 10 * 60, // 10 minutes, matching access token lifetime
      });

      const response: AuthResponse = {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          domain: user.domain,
          isAdmin: user.isAdmin,
        },
        token,
        refreshToken,
        isNewUser: false,
      };

      return c.json(response, 200);
    } catch (error) {
      getRouteLogger().error('Password auth error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return c.json({
        error: 'Authentication failed'
      }, 400);
    }
  }
);

/**
 * POST /api/tokens/google
 *
 * Google OAuth Authentication - Spec-First Version
 * Authenticate with Google OAuth access token
 *
 * Request validation: Uses validateRequestBody middleware with 'GoogleAuthRequest' schema
 * Response type: AuthResponse from OpenAPI spec
 */
authRouter.post('/api/tokens/google',
  validateRequestBody('GoogleAuthRequest'),
  async (c) => {
    try {
      const body = c.get('validatedBody') as GoogleAuthRequest;
      const { access_token } = body;

      if (!access_token) {
        return c.json({
          error: 'Missing access token'
        }, 400);
      }

      // Verify Google token and get user info
      const googleUser = await OAuthService.verifyGoogleToken(googleCredential(access_token));

      // Create or update user (returns access + refresh tokens)
      const { user, token, refreshToken, isNewUser } = await OAuthService.createOrUpdateUser(googleUser);

      setCookie(c, 'semiont-token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/',
        maxAge: 10 * 60, // 10 minutes, matching access token lifetime
      });

      const response: AuthResponse = {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          domain: user.domain,
          isAdmin: user.isAdmin,
        },
        token,
        refreshToken,
        isNewUser,
      };

      return c.json(response, 200);
    } catch (error) {
      getRouteLogger().error('OAuth authentication error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      const errorMessage = error instanceof Error ? error.message : 'Authentication failed';
      return c.json({ error: errorMessage }, 400);
    }
  }
);

/**
 * POST /api/tokens/refresh
 *
 * Refresh Access Token - Spec-First Version
 * Exchange a refresh token for a new access token
 *
 * Request validation: Uses validateRequestBody middleware with 'TokenRefreshRequest' schema
 * Response type: TokenRefreshResponse from OpenAPI spec
 */
authRouter.post('/api/tokens/refresh',
  validateRequestBody('TokenRefreshRequest'),
  async (c) => {
    getRouteLogger().debug('Refresh endpoint hit');
    const body = c.get('validatedBody') as TokenRefreshRequest;
    const { refreshToken } = body;

    if (!refreshToken) {
      getRouteLogger().debug('Refresh endpoint: No refresh token provided');
      return c.json({ error: 'Refresh token required' }, 401);
    }

    getRouteLogger().debug('Refresh endpoint: Attempting to verify token');

    try {
      // Verify refresh token
      const payload = JWTService.verifyToken(refreshToken);
      getRouteLogger().debug('Refresh endpoint: Token verified', { userId: payload.userId });

      if (!payload.userId) {
        getRouteLogger().debug('Refresh endpoint: No userId in token payload');
        return c.json({ error: 'Invalid token payload' }, 401);
      }

      // Get user from database to ensure they still exist and are active
      const prisma = DatabaseConnection.getClient();
      const user = await prisma.user.findUnique({
        where: { id: payload.userId }
      });

      if (!user || !user.isActive) {
        return c.json({ error: 'User not found or inactive' }, 401);
      }

      // Per-user revocation epoch (SDK-AUTH-CORS Phase 2): a refresh token
      // whose tokenVersion is behind the user's current value has been revoked
      // (e.g. by logout).
      if (payload.tokenVersion !== user.tokenVersion) {
        return c.json({ error: 'Token revoked' }, 401);
      }

      // Generate new short-lived access token (1 hour)
      const accessTokenPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
        userId: makeUserId(user.id),
        email: makeEmail(user.email),
        domain: user.domain,
        provider: user.provider,
        isAdmin: user.isAdmin,
        ...(user.name && { name: user.name }),
        tokenVersion: user.tokenVersion,
      };
      const accessToken = JWTService.generateToken(accessTokenPayload, '10m'); // 10 minute expiration

      const response: TokenRefreshResponse = {
        access_token: accessToken
      };

      return c.json(response, 200);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      getRouteLogger().error('Token refresh error', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      });

      // Provide specific error messages for different failure modes
      if (errorMessage.includes('expired')) {
        return c.json({ error: 'Refresh token expired - please re-provision' }, 401);
      }
      if (errorMessage.includes('signature')) {
        return c.json({ error: 'Invalid refresh token' }, 401);
      }

      return c.json({ error: 'Failed to refresh token' }, 401);
    }
  }
);

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
    isActive: user.isActive,
    termsAcceptedAt: user.termsAcceptedAt?.toISOString() || null,
    lastLogin: user.lastLogin?.toISOString() || null,
    created: user.createdAt.toISOString(),
    token,
  };

  return c.json(response, 200);
});


/**
 * POST /api/tokens/agent
 *
 * Software-agent token exchange. A worker process presents the shared
 * `SEMIONT_WORKER_SECRET` along with the inference (provider, model)
 * the token is being issued for. The backend upserts a User row that
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
      isActive: true,
      lastLogin: new Date(),
    },
    create: {
      email: agentEmail,
      name: agentName,
      provider: 'agent',
      providerId,
      domain: siteDomain,
      isActive: true,
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
    tokenVersion: agentUser.tokenVersion,
  }, '24h');

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
 * POST /api/users/accept-terms
 *
 * Accept Terms - Mark terms as accepted for the current user
 * Requires authentication
 * Response type: AcceptTermsResponse from OpenAPI spec
 */
authRouter.post('/api/users/accept-terms', authMiddleware, async (c) => {
  const user = c.get('user');

  // Update the user's terms acceptance
  await OAuthService.acceptTerms(makeUserId(user.id));

  const response: AcceptTermsResponse = {
    success: true,
    message: 'Terms accepted',
  };

  return c.json(response, 200);
});

/**
 * POST /api/users/logout
 *
 * Logout - Logout the current user
 * Requires authentication
 * In JWT-based auth, logout is handled client-side
 * This endpoint exists for consistency and future session management
 */
authRouter.post('/api/users/logout', authMiddleware, async (c) => {
  // Revoke every outstanding token for this user by bumping the per-user
  // revocation epoch (SDK-AUTH-CORS Phase 2) — refresh and live access tokens
  // minted at the old version are rejected from here on.
  const user = c.get('user');
  const prisma = DatabaseConnection.getClient();
  await prisma.user.update({
    where: { id: user.id },
    data: { tokenVersion: { increment: 1 } },
  });
  deleteCookie(c, 'semiont-token', { path: '/' }); // cookie removal lands in Phase 3
  return c.body(null, 204);
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
