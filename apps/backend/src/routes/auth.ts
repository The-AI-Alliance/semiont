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
import type { User } from '@prisma/client';
import type { JWTPayload as ValidatedJWTPayload } from '../types/jwt-types';
import type { components } from '@semiont/api-client';

// Types from OpenAPI spec (generated)
type LocalAuthRequest = components['schemas']['LocalAuthRequest'];
type GoogleAuthRequest = components['schemas']['GoogleAuthRequest'];
type TokenRefreshRequest = components['schemas']['TokenRefreshRequest'];
type AuthResponse = components['schemas']['AuthResponse'];
type TokenRefreshResponse = components['schemas']['TokenRefreshResponse'];
type UserResponse = components['schemas']['UserResponse'];

// Create auth router with plain Hono
export const authRouter = new Hono<{ Variables: { user: User; validatedBody: unknown } }>();

/**
 * POST /api/tokens/local
 *
 * Local development authentication - validates request against OpenAPI schema
 *
 * Request validation: Uses validateRequestBody middleware with 'LocalAuthRequest' schema
 * Response type: AuthResponse from OpenAPI spec
 */
authRouter.post('/api/tokens/local',
  validateRequestBody('LocalAuthRequest'),  // ← Validate against OpenAPI schema
  async (c) => {
    // Only allow in development mode
    if (process.env.NODE_ENV !== 'development' && process.env.ENABLE_LOCAL_AUTH !== 'true') {
      return c.json({
        error: 'Local authentication is not enabled'
      }, 403);
    }

    try {
      // Get validated body from context (already validated by middleware)
      const body = c.get('validatedBody') as LocalAuthRequest;
      const { email } = body;

      // Get user from database by email
      const prisma = DatabaseConnection.getClient();
      const user = await prisma.user.findUnique({
        where: { email }
      });

      if (!user) {
        return c.json({
          error: 'User not found. Please ensure the user has been seeded during backend provisioning.'
        }, 400);
      }

      if (!user.isActive) {
        return c.json({
          error: 'User is not active'
        }, 400);
      }

      // Generate JWT token for the user
      const jwtPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
        userId: user.id,
        email: user.email,
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
      console.error('[LocalAuth] Error:', error);
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
      const googleUser = await OAuthService.verifyGoogleToken(access_token);

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
        userId: user.id,
        email: user.email,
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
