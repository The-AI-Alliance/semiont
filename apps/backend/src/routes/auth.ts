import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { 
  GoogleAuthRequestSchema, 
  AuthResponseSchema, 
  UserResponseSchema,
  ErrorResponseSchema 
} from '../openapi';
import { OAuthService } from '../auth/oauth';
import { JWTService } from '../auth/jwt';
import { authMiddleware } from '../middleware/auth';
import { DatabaseConnection } from '../db';
import { User } from '@prisma/client';
import { JWTPayload as ValidatedJWTPayload } from '@semiont/api-types';

// Token refresh request schema
const TokenRefreshRequestSchema = z.object({
  refreshToken: z.string().openapi({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'Refresh token obtained during login',
  }),
});

// Token refresh response schema
const TokenRefreshResponseSchema = z.object({
  access_token: z.string().openapi({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'JWT access token (1 hour expiration)',
  }),
});

// MCP token generate schema  
const MCPGenerateResponseSchema = z.object({
  refresh_token: z.string().openapi({
    example: 'eyJhbGciOiJIUzI1NiIs...',
    description: 'JWT refresh token (30 day expiration)',
  }),
});

// Accept terms response schema
const AcceptTermsResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

// Logout response schema
const LogoutResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
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
          schema: LocalAuthRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: AuthResponseSchema,
        },
      },
      description: 'Successful authentication',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Bad request',
    },
    403: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
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
          schema: GoogleAuthRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: AuthResponseSchema,
        },
      },
      description: 'Successful authentication',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
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
          schema: TokenRefreshRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: TokenRefreshResponseSchema,
        },
      },
      description: 'New access token generated',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
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
          schema: MCPGenerateResponseSchema,
        },
      },
      description: 'MCP token generated',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
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
          schema: UserResponseSchema,
        },
      },
      description: 'User information',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
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
          schema: AcceptTermsResponseSchema,
        },
      },
      description: 'Terms accepted successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
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
          schema: LogoutResponseSchema,
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

    return c.json({
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
    }, 200);
  } catch (error: any) {
    console.error('Local auth error:', error);
    return c.json({ error: error.message || 'Authentication failed' }, 400);
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
    
    return c.json({
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
    }, 200);
  } catch (error: any) {
    console.error('OAuth error:', error);
    return c.json({ error: error.message || 'Authentication failed' }, 400);
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
    const accessTokenPayload: any = {
      userId: user.id,
      email: user.email,
      domain: user.domain,
      provider: user.provider,
      isAdmin: user.isAdmin
    };
    if (user.name) {
      accessTokenPayload.name = user.name;
    }
    const accessToken = JWTService.generateToken(accessTokenPayload, '1h'); // 1 hour expiration
    
    // Return in the format MCP expects
    return c.json({ 
      access_token: accessToken  // Note: using snake_case for consistency
    }, 200);
  } catch (error: any) {
    console.error('Token refresh error:', error.message || error);
    console.error('Error stack:', error.stack);
    
    // Provide specific error messages for different failure modes
    if (error.message?.includes('expired')) {
      return c.json({ error: 'Refresh token expired - please re-provision' }, 401);
    }
    if (error.message?.includes('signature')) {
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
    const tokenPayload: any = {
      userId: user.id,
      email: user.email,
      domain: user.domain,
      provider: user.provider,
      isAdmin: user.isAdmin
    };
    if (user.name) {
      tokenPayload.name = user.name;
    }
    const refreshToken = JWTService.generateToken(tokenPayload, '30d'); // 30 day expiration
    
    return c.json({ 
      refresh_token: refreshToken  // Note: returning refresh_token, not access_token
    }, 200);
  } catch (error: any) {
    console.error('MCP token generation error:', error);
    return c.json({ error: 'Failed to generate refresh token' }, 401);
  }
});

// Get current user endpoint
authRouter.use('/api/users/me', authMiddleware);
authRouter.openapi(getCurrentUserRoute, async (c) => {
  const user = c.get('user');
  
  return c.json({
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
    createdAt: user.createdAt.toISOString(),
  }, 200);
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
  return c.json({
    success: true,
    message: 'Logged out successfully',
  }, 200);
});