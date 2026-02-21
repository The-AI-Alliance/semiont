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
import { validateRequestBody } from '../middleware/validate-openapi';
import { authMiddleware } from '../middleware/auth';
import { DatabaseConnection } from '../db';
import { JWTService } from '../auth/jwt';
import { OAuthService } from '../auth/oauth';
import bcrypt from 'bcrypt';
import type { User } from '@prisma/client';
import type { JWTPayload as ValidatedJWTPayload } from '../types/jwt-types';
import type { components } from '@semiont/core';
import { userId as makeUserId, googleCredential, email as makeEmail } from '@semiont/core';
import { getLogger } from '../logger';
import { createSafeLogContext } from '../utils/log-sanitizer';

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
export const authRouter = new Hono<{ Variables: { user: User; validatedBody: unknown } }>();

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
    const logger = getLogger();

    try {
      const body = c.get('validatedBody') as PasswordAuthRequest;
      const { email, password } = body;

      logger.debug('Password auth attempt', { email });

      // Get user from database by email
      const prisma = DatabaseConnection.getClient();
      const user = await prisma.user.findUnique({
        where: { email }
      });

      // Return same error for user not found and wrong password (security)
      if (!user) {
        logger.debug('Password auth failed: user not found', { email });
        return c.json({
          error: 'Invalid credentials'
        }, 401);
      }

      logger.debug('User found', createSafeLogContext({
        email,
        provider: user.provider,
        isActive: user.isActive,
        hasPasswordHash: !!user.passwordHash
      }));

      // Verify user is password provider
      if (user.provider !== 'password') {
        logger.debug('Password auth failed: wrong provider', {
          email,
          provider: user.provider
        });
        return c.json({
          error: 'This account uses OAuth. Please sign in with Google.'
        }, 400);
      }

      // Verify password hash exists
      if (!user.passwordHash) {
        logger.debug('Password auth failed: no password hash', { email });
        return c.json({
          error: 'Password not set for this account'
        }, 400);
      }

      // Verify password
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        logger.debug('Password auth failed: invalid password', { email });
        return c.json({
          error: 'Invalid credentials'
        }, 401);
      }

      // Check if user is active
      if (!user.isActive) {
        logger.debug('Password auth failed: inactive account', { email });
        return c.json({
          error: 'Account is not active'
        }, 403);
      }

      logger.debug('Password auth successful', { email });

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
      logger.error('Password auth error', {
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
      console.error('OAuth error:', error);
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
    console.log('Refresh endpoint hit');
    const body = c.get('validatedBody') as TokenRefreshRequest;
    const { refreshToken } = body;

    if (!refreshToken) {
      console.log('Refresh endpoint: No refresh token provided');
      return c.json({ error: 'Refresh token required' }, 401);
    }

    console.log('Refresh endpoint: Attempting to verify token');

    try {
      // Verify refresh token
      const payload = JWTService.verifyToken(refreshToken);
      console.log('Refresh endpoint: Token verified, userId:', payload.userId);

      if (!payload.userId) {
        console.log('Refresh endpoint: No userId in token payload');
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
      console.error('Token refresh error:', errorMessage);
      if (error instanceof Error) {
        console.error('Error stack:', error.stack);
      }

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
  };

  return c.json(response, 200);
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
    console.error('MCP token generation error:', error);
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
  return c.json({
    success: true,
    message: 'Logged out successfully',
  }, 200);
});
