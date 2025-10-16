import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  GoogleAuthRequestSchema,
  AuthResponseSchema,
  UserResponseSchema,
  AcceptTermsResponseSchema,
  TokenRefreshResponseSchema,
  MCPGenerateResponseSchema,
  LogoutResponseSchema,
  type AuthResponse,
  type UserResponse,
  type TokenRefreshResponse,
  type MCPGenerateResponse,
  type LogoutResponse,
} from '@semiont/core';
import { ErrorResponseSchema } from '../openapi';
import { OAuthService } from '../auth/oauth';
import { JWTService } from '../auth/jwt';
import { authMiddleware } from '../middleware/auth';
import { DatabaseConnection } from '../db';
import { User } from '@prisma/client';
import { JWTPayload as ValidatedJWTPayload } from '../types/jwt-types';

// Token refresh request schema
const TokenRefreshRequestSchema = z.object({
  refreshToken: z.string().openapi({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'Refresh token obtained during login',
  }),
});

// Local auth request schema (for development only)
const LocalAuthRequestSchema = z.object({
  email: z.string().email(),
});

// Local auth route (for development only)
export const localAuthRoute = createRoute({
  method: 'post',
  path: '/api/tokens/local',
  summary: 'Local Development Authentication',
  description: 'Authenticate with email only (development mode only)',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: LocalAuthRequestSchema as any,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: AuthResponseSchema as any,
        },
      },
      description: 'Successful authentication',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Bad request',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Local auth not enabled',
    },
  },
});

// Google auth route
export const googleAuthRoute = createRoute({
  method: 'post',
  path: '/api/tokens/google',
  summary: 'Google OAuth Authentication',
  description: 'Authenticate with Google OAuth access token',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: GoogleAuthRequestSchema as any,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: AuthResponseSchema as any,
        },
      },
      description: 'Successful authentication',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Invalid request or authentication failed',
    },
  },
});

// Token refresh route
export const refreshTokenRoute = createRoute({
  method: 'post',
  path: '/api/tokens/refresh',
  summary: 'Refresh Access Token',
  description: 'Exchange a refresh token for a new access token',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: TokenRefreshRequestSchema as any,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: TokenRefreshResponseSchema as any,
        },
      },
      description: 'New access token generated',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Invalid or expired refresh token',
    },
  },
});

// MCP token generate route
export const mcpGenerateRoute = createRoute({
  method: 'post',
  path: '/api/tokens/mcp-generate',
  summary: 'Generate MCP Token',
  description: 'Generate a short-lived token for MCP server',
  tags: ['Authentication'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: MCPGenerateResponseSchema as any,
        },
      },
      description: 'MCP token generated',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Unauthorized',
    },
  },
});

// Get current user route
export const getCurrentUserRoute = createRoute({
  method: 'get',
  path: '/api/users/me',
  summary: 'Get Current User',
  description: 'Get information about the authenticated user',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: UserResponseSchema as any,
        },
      },
      description: 'User information',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Unauthorized',
    },
  },
});

// Accept terms route
export const acceptTermsRoute = createRoute({
  method: 'post',
  path: '/api/users/accept-terms',
  summary: 'Accept Terms',
  description: 'Mark terms as accepted for the current user',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: AcceptTermsResponseSchema as any,
        },
      },
      description: 'Terms accepted successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema as any,
        },
      },
      description: 'Unauthorized',
    },
  },
});

// Logout route
export const logoutRoute = createRoute({
  method: 'post',
  path: '/api/users/logout',
  summary: 'Logout',
  description: 'Logout the current user',
  tags: ['Users'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: LogoutResponseSchema as any,
        },
      },
      description: 'Logged out successfully',
    },
  },
});

// Create auth router
export const authRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Local auth endpoint (development only)
authRouter.openapi(localAuthRoute, async (c) => {
  // Only allow in development mode
  if (process.env.NODE_ENV !== 'development' && process.env.ENABLE_LOCAL_AUTH !== 'true') {
    return c.json({
      error: 'Local authentication is not enabled'
    }, 403);
  }

  try {
    const body = await c.req.valid('json');
    const { email } = body;

    if (!email) {
      return c.json({
        error: 'Email is required'
      }, 400);
    }

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
    console.error('Local auth error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Authentication failed';
    return c.json({ error: errorMessage }, 400);
  }
});

// Google auth endpoint
authRouter.openapi(googleAuthRoute, async (c) => {
  try {
    const body = await c.req.valid('json');
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
});

// Token refresh endpoint - exchanges refresh token for access token
authRouter.openapi(refreshTokenRoute, async (c) => {
  console.log('Refresh endpoint hit');
  const body = await c.req.valid('json');
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
});

// MCP token generate endpoint - generates long-lived refresh token
authRouter.use('/api/tokens/mcp-generate', authMiddleware);
authRouter.openapi(mcpGenerateRoute, async (c) => {
  const user = c.get('user');
  
  try {
    // Generate long-lived refresh token (30 days) for MCP
    const tokenPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
      userId: user.id,
      email: user.email,
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

// Get current user endpoint
authRouter.use('/api/users/me', authMiddleware);
authRouter.openapi(getCurrentUserRoute, async (c) => {
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

// Accept terms endpoint
authRouter.use('/api/users/accept-terms', authMiddleware);
authRouter.openapi(acceptTermsRoute, async (c) => {
  const user = c.get('user');
  
  // Update the user's terms acceptance
  await OAuthService.acceptTerms(user.id);
  
  return c.json({
    success: true,
    message: 'Terms accepted',
  }, 200);
});

// Logout endpoint
authRouter.use('/api/users/logout', authMiddleware);
authRouter.openapi(logoutRoute, async (c) => {
  // In JWT-based auth, logout is handled client-side
  // This endpoint exists for consistency and future session management
  const response: LogoutResponse = {
    success: true,
    message: 'Logged out successfully',
  };

  return c.json(response, 200);
});