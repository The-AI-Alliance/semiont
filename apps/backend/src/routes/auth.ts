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
import { userId as makeUserId, googleCredential, email as makeEmail } from '@semiont/core';
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
type MCPGenerateResponse = components['schemas']['MCPGenerateResponse'];

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

      // Generate JWT token
      const jwtPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
        userId: makeUserId(user.id),
        email: makeEmail(user.email),
        ...(user.name && { name: user.name }),
        domain: user.domain,
        provider: user.provider,
        isAdmin: user.isAdmin,
      };

      const token = JWTService.generateToken(jwtPayload);

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
        maxAge: 7 * 24 * 60 * 60,
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

      // Create or update user
      const { user, token, isNewUser } = await OAuthService.createOrUpdateUser(googleUser);

      setCookie(c, 'semiont-token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
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

      // Generate new short-lived access token (1 hour)
      const accessTokenPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
        userId: makeUserId(user.id),
        email: makeEmail(user.email),
        domain: user.domain,
        provider: user.provider,
        isAdmin: user.isAdmin,
        ...(user.name && { name: user.name })
      };
      const accessToken = JWTService.generateToken(accessTokenPayload, '1h'); // 1 hour expiration

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
    isActive: user.isActive,
    termsAcceptedAt: user.termsAcceptedAt?.toISOString() || null,
    lastLogin: user.lastLogin?.toISOString() || null,
    created: user.createdAt.toISOString(),
    token,
  };

  return c.json(response, 200);
});

/**
 * GET /api/tokens/mcp-setup?callback=...
 *
 * MCP CLI Token Setup - Browser-initiated flow that reads the httpOnly semiont-token
 * cookie, generates a long-lived MCP refresh token, and redirects to the CLI callback URL.
 * Requires authentication (cookie or Bearer).
 */
authRouter.get('/api/tokens/mcp-setup', authMiddleware, async (c) => {
  const callback = c.req.query('callback');

  if (!callback) {
    return c.json({ error: 'Callback URL required' }, 400);
  }

  // Allow only localhost callbacks (following Google OAuth pattern for CLI auth)
  const allowedCallbackPatterns = [
    /^http:\/\/localhost:\d+\/.*$/,
    /^http:\/\/127\.0\.0\.1:\d+\/.*$/,
    /^http:\/\/\[::1\]:\d+\/.*$/,
  ];

  if (!allowedCallbackPatterns.some(p => p.test(callback))) {
    return c.json({ error: 'Invalid callback URL. Must be a localhost URL for CLI authentication.' }, 400);
  }

  const user = c.get('user');

  try {
    const tokenPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
      userId: makeUserId(user.id),
      email: makeEmail(user.email),
      domain: user.domain,
      provider: user.provider,
      isAdmin: user.isAdmin,
      ...(user.name && { name: user.name })
    };
    const refreshToken = JWTService.generateToken(tokenPayload, '30d');

    return c.redirect(`${callback}?token=${refreshToken}`, 302);
  } catch (error) {
    getRouteLogger().error('MCP setup error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return c.json({ error: 'Failed to generate refresh token' }, 500);
  }
});

/**
 * POST /api/tokens/mcp-generate
 *
 * Generate MCP Token - Generate a short-lived token for MCP server
 * Requires authentication
 * Response type: MCPGenerateResponse from OpenAPI spec
 */
authRouter.post('/api/tokens/mcp-generate', authMiddleware, async (c) => {
  const user = c.get('user');

  try {
    // Generate long-lived refresh token (30 days) for MCP
    const tokenPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
      userId: makeUserId(user.id),
      email: makeEmail(user.email),
      domain: user.domain,
      provider: user.provider,
      isAdmin: user.isAdmin,
      ...(user.name && { name: user.name })
    };
    const refreshToken = JWTService.generateToken(tokenPayload, '30d'); // 30 day expiration

    const response: MCPGenerateResponse = {
      refresh_token: refreshToken
    };

    return c.json(response, 200);
  } catch (error) {
    getRouteLogger().error('MCP token generation error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return c.json({ error: 'Failed to generate refresh token' }, 401);
  }
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
  deleteCookie(c, 'semiont-token', { path: '/' });
  return c.json({
    success: true,
    message: 'Logged out successfully',
  }, 200);
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
