// Construct DATABASE_URL from components if not already set
// MUST be done before any Prisma imports!
if (!process.env.DATABASE_URL && process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD) {
  const url = new URL('postgresql://localhost');
  url.username = process.env.DB_USER;
  url.password = process.env.DB_PASSWORD; // Automatically URL-encoded by URL class
  url.hostname = process.env.DB_HOST;
  url.port = process.env.DB_PORT || '5432';
  url.pathname = `/${process.env.DB_NAME || 'semiont'}`;
  url.searchParams.set('sslmode', 'require');
  
  process.env.DATABASE_URL = url.toString();
  console.log('✅ DATABASE_URL constructed from components');
}

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';

import { DatabaseConnection } from './db';
import { OAuthService } from './auth/oauth';
import { JWTService } from './auth/jwt';
import { authMiddleware } from './middleware/auth';
import { User } from '@prisma/client';
import { openApiConfig, routes } from './openapi';

// Configuration is loaded in JWT service when needed
// For the server itself, we use environment variables
const CONFIG = {
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 4000,
};

import {
  AuthResponse,
  UserResponse,
  ErrorResponse,
  HelloResponse,
  StatusResponse,
  HealthResponse,
  LogoutResponse,
  HelloParams,
  GoogleAuthRequest
} from './types/api';
import {
  GoogleAuthSchema,
  HelloParamsSchema,
  validateData
} from './validation/schemas';

type Variables = {
  user: User;
};


const app = new Hono<{ Variables: Variables }>();

// Add CORS middleware
app.use('*', cors({
  origin: CONFIG.CORS_ORIGIN || CONFIG.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

// Create OpenAPI documentation app
const openAPIApp = new OpenAPIHono();

// Register all route definitions for documentation
Object.values(routes).forEach(route => {
  // We're only using this for documentation generation, not actual routing
  openAPIApp.openapi(route, async () => new Response());
});

// Generate OpenAPI specification
const openApiSpec = openAPIApp.getOpenAPI31Document(openApiConfig);

// Middleware for documentation authentication
const docsAuthMiddleware = async (c: any, next: any) => {
  // Check for token in query parameter for browser-based access
  const token = c.req.query('token');
  if (token) {
    try {
      const user = await OAuthService.getUserFromToken(token);
      c.set('user', user);
      return next();
    } catch (error) {
      return c.json({ error: 'Invalid token' }, 401);
    }
  }
  
  // Check for Bearer token in header
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const headerToken = authHeader.substring(7).trim();
  try {
    const user = await OAuthService.getUserFromToken(headerToken);
    c.set('user', user);
    return next();
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401);
  }
};

// API Documentation root - redirect to appropriate format
app.get('/api', docsAuthMiddleware, (c) => {
  const acceptHeader = c.req.header('Accept') || '';
  const userAgent = c.req.header('User-Agent') || '';
  const token = c.req.query('token');
  
  // If request is from a browser, redirect to Swagger UI
  if (acceptHeader.includes('text/html') || userAgent.includes('Mozilla')) {
    // Preserve token in redirect if it was provided
    const redirectUrl = token ? `/api/docs?token=${token}` : '/api/docs';
    return c.redirect(redirectUrl);
  }

  // For API clients requesting JSON, redirect to OpenAPI spec
  const redirectUrl = token ? `/api/openapi.json?token=${token}` : '/api/openapi.json';
  return c.redirect(redirectUrl);
});

// Serve OpenAPI JSON specification
app.get('/api/openapi.json', docsAuthMiddleware, (c) => {
  return c.json(openApiSpec);
});

// Serve Swagger UI documentation - with authentication
app.get('/api/docs', docsAuthMiddleware, async (c) => {
  // User is authenticated via middleware
  const token = c.req.query('token');
  
  try {
    const swaggerHandler = swaggerUI({ 
      url: token ? `/api/openapi.json?token=${token}` : '/api/openapi.json',
      persistAuthorization: true,
      title: 'Semiont API Documentation'
    });
    
    // TypeScript workarounds: swaggerUI has type mismatches
    // - It's typed as MiddlewareHandler expecting (c, next) but runtime only uses (c)
    // - Context type incompatibility requires 'as any' cast
    return await swaggerHandler(c as any, async () => {});
  } catch (error) {
    console.error('Error in /api/docs handler:', error);
    return c.json({ error: 'Failed to load documentation', details: String(error) }, 500);
  }
});

// Redirect /api/swagger to /api/docs for convenience
app.get('/api/swagger', docsAuthMiddleware, (c) => {
  const token = c.req.query('token');
  const redirectUrl = token ? `/api/docs?token=${token}` : '/api/docs';
  return c.redirect(redirectUrl);
});

// Public endpoints - these don't require authentication
const PUBLIC_ENDPOINTS = [
  '/api/health',          // Required for ALB health checks
  '/api/auth/google',     // OAuth login initiation (keeping for compatibility)
  '/api/tokens/google',   // New OAuth endpoint location
  '/api/tokens/refresh',  // Token refresh endpoint (uses refresh token for auth)
  // '/api/auth/callback',   // OAuth callback (reserved for future backend OAuth flow)
];

// Apply authentication middleware to all /api/* routes except public endpoints
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  
  // Check if this is a public endpoint (exact match only)
  if (PUBLIC_ENDPOINTS.includes(path)) {
    return next();
  }
  
  // Documentation endpoints have their own auth via docsAuthMiddleware
  if (['/api/docs', '/api/swagger', '/api/openapi.json', '/api'].includes(path)) {
    return next();
  }
  
  // All other endpoints require authentication
  return authMiddleware(c, next);
});

// Hello endpoints (now requires authentication)
app.get('/api/hello/:name?', (c) => {
  const user = c.get('user'); // Get authenticated user
  const params = { name: c.req.param('name') };
  
  // Validate parameters
  const validation = validateData(HelloParamsSchema, params);
  if (!validation.success) {
    return c.json<ErrorResponse>({ 
      error: 'Invalid parameters', 
      details: validation.details 
    }, 400);
  }
  
  const name = (validation.data as HelloParams).name || user?.name || 'World';
  
  return c.json<HelloResponse>({
    message: `Hello, ${name}! Welcome to Semiont.`,
    timestamp: new Date().toISOString(),
    platform: 'Semiont Semantic Knowledge Platform',
    user: user?.email, // Include authenticated user info if available
  });
});

app.get('/api/status', (c) => {
  const user = c.get('user'); // Get authenticated user
  return c.json<StatusResponse>({
    status: 'operational',
    version: '0.1.0',
    features: {
      semanticContent: 'planned',
      collaboration: 'planned',
      rbac: 'planned',
    },
    message: 'Ready to build the future of knowledge management!',
    authenticatedAs: user?.email, // Include who's checking status if available
  });
});

// OAuth endpoints
// Duplicate at /api/tokens/google for new path structure
app.post('/api/tokens/google', async (c) => {
  try {
    const body = await c.req.json();
    
    // Validate request body
    const validation = validateData(GoogleAuthSchema, body);
    if (!validation.success) {
      return c.json<ErrorResponse>({ 
        error: 'Invalid request body', 
        details: validation.details 
      }, 400);
    }
    
    const { access_token } = validation.data as GoogleAuthRequest;

    if (!access_token) {
      return c.json<ErrorResponse>({
        error: 'Missing access token'
      }, 400);
    }

    // Verify Google token and get user info
    const googleUser = await OAuthService.verifyGoogleToken(access_token);
    
    // Create or update user
    const { user, token, isNewUser } = await OAuthService.createOrUpdateUser(googleUser);
    
    return c.json<AuthResponse>({
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
    });
  } catch (error: any) {
    console.error('OAuth error:', error);
    return c.json<ErrorResponse>({ error: error.message || 'Authentication failed' }, 400);
  }
});

// Keep old endpoint for backward compatibility during transition
app.post('/api/auth/google', async (c) => {
  try {
    const body = await c.req.json();
    
    // Validate request body
    const validation = validateData(GoogleAuthSchema, body);
    if (!validation.success) {
      return c.json<ErrorResponse>({ 
        error: 'Invalid request body', 
        details: validation.details 
      }, 400);
    }
    
    const { access_token } = validation.data as GoogleAuthRequest;

    if (!access_token) {
      return c.json<ErrorResponse>({
        error: 'Missing access token'
      }, 400);
    }

    // Verify Google token and get user info
    const googleUser = await OAuthService.verifyGoogleToken(access_token);
    
    // Create or update user
    const { user, token, isNewUser } = await OAuthService.createOrUpdateUser(googleUser);
    
    return c.json<AuthResponse>({
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
    });
  } catch (error: any) {
    console.error('OAuth error:', error);
    return c.json<ErrorResponse>({ error: error.message || 'Authentication failed' }, 400);
  }
});

app.get('/api/users/me', async (c) => {
  const user = c.get('user'); // Auth already applied globally
  return c.json<UserResponse>({
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
  });
});

app.post('/api/users/logout', async (c) => {
  // Auth already applied globally
  // For stateless JWT, we just return success
  // The client should remove the token
  return c.json<LogoutResponse>({ success: true, message: 'Logged out successfully' });
});

app.post('/api/users/accept-terms', async (c) => {
  const user = c.get('user'); // Auth already applied globally
  
  try {
    // Update user's terms acceptance timestamp
    const prisma = DatabaseConnection.getClient();
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { termsAcceptedAt: new Date() }
    });
    
    return c.json({
      success: true,
      message: 'Terms accepted successfully',
      termsAcceptedAt: updatedUser.termsAcceptedAt?.toISOString()
    });
  } catch (error: any) {
    console.error('Terms acceptance error:', error);
    return c.json<ErrorResponse>({ error: 'Failed to record terms acceptance' }, 500);
  }
});

// MCP refresh token endpoint - generates long-lived refresh token
// This endpoint is called by the frontend after NextAuth authentication
app.post('/api/tokens/mcp-generate', authMiddleware, async (c) => {
  const user = c.get('user');
  
  try {
    // Generate long-lived refresh token (30 days)
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
    const refreshToken = JWTService.generateToken(tokenPayload, '30d'); // 30 day expiration for refresh tokens
    
    return c.json({ refresh_token: refreshToken });
  } catch (error: any) {
    console.error('MCP token generation error:', error);
    return c.json<ErrorResponse>({ error: 'Failed to generate refresh token' }, 500);
  }
});

// Refresh token endpoint for MCP - exchanges refresh token for access token
app.post('/api/tokens/refresh', async (c) => {
  console.log('Refresh endpoint hit');
  const body = await c.req.json();
  const { refresh_token } = body;
  
  if (!refresh_token) {
    console.log('Refresh endpoint: No refresh token provided');
    return c.json<ErrorResponse>({ error: 'Refresh token required' }, 400);
  }
  
  console.log('Refresh endpoint: Attempting to verify token');
  
  try {
    // Verify refresh token
    const payload = JWTService.verifyToken(refresh_token);
    console.log('Refresh endpoint: Token verified, userId:', payload.userId);
    
    if (!payload.userId) {
      console.log('Refresh endpoint: No userId in token payload');
      return c.json<ErrorResponse>({ error: 'Invalid token payload' }, 401);
    }
    
    // Get user from database to ensure they still exist and are active
    const prisma = DatabaseConnection.getClient();
    const user = await prisma.user.findUnique({
      where: { id: payload.userId }
    });
    
    if (!user) {
      return c.json<ErrorResponse>({ error: 'User not found' }, 401);
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
    const accessToken = JWTService.generateToken(accessTokenPayload, '1h'); // 1 hour expiration for access tokens
    
    return c.json({ access_token: accessToken });
  } catch (error: any) {
    console.error('Token refresh error:', error.message || error);
    console.error('Error stack:', error.stack);
    
    // Provide specific error messages for different failure modes
    if (error.message?.includes('expired')) {
      return c.json<ErrorResponse>({ error: 'Refresh token expired - please re-provision' }, 401);
    }
    if (error.message?.includes('signature')) {
      return c.json<ErrorResponse>({ error: 'Invalid refresh token' }, 401);
    }
    
    return c.json<ErrorResponse>({ error: 'Failed to refresh token' }, 401);
  }
});

// Admin middleware - ensures user is an admin (auth already applied globally)
const adminMiddleware = async (c: any, next: any) => {
  const user = c.get('user'); // User should be already authenticated
  
  // If user is undefined, authentication failed - return 401
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  // If user exists but is not admin - return 403
  if (!user.isAdmin) {
    return c.json({ error: 'Admin access required' }, 403);
  }
  
  await next();
};

// Admin user management routes
app.get('/api/admin/users', adminMiddleware, async (c) => {
  try {
    const prisma = DatabaseConnection.getClient();
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        domain: true,
        provider: true,
        isAdmin: true,
        isActive: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
      }
    });
    
    return c.json({
      success: true,
      users: users.map(user => ({
        ...user,
        lastLogin: user.lastLogin?.toISOString() || null,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      }))
    });
  } catch (error: any) {
    console.error('Failed to fetch users:', error);
    return c.json<ErrorResponse>({ error: 'Failed to fetch users' }, 500);
  }
});

app.get('/api/admin/users/stats', adminMiddleware, async (c) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const prisma = DatabaseConnection.getClient();
    const [totalUsers, activeUsers, adminUsers, recentUsers] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { isAdmin: true } }),
      prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    ]);
    
    return c.json({
      success: true,
      stats: {
        total: totalUsers,
        active: activeUsers,
        admins: adminUsers,
        recent: recentUsers,
      }
    });
  } catch (error: any) {
    console.error('Failed to fetch user stats:', error);
    return c.json<ErrorResponse>({ error: 'Failed to fetch user statistics' }, 500);
  }
});

app.patch('/api/admin/users/:id', adminMiddleware, async (c) => {
  try {
    const userId = c.req.param('id');
    const body = await c.req.json();
    
    // Validate the user exists
    const prisma = DatabaseConnection.getClient();
    const existingUser = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!existingUser) {
      return c.json<ErrorResponse>({ error: 'User not found' }, 404);
    }
    
    // Update user with provided fields
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(body.isAdmin !== undefined && { isAdmin: Boolean(body.isAdmin) }),
        ...(body.isActive !== undefined && { isActive: Boolean(body.isActive) }),
        ...(body.name !== undefined && { name: body.name }),
      },
    });
    
    return c.json({
      success: true,
      user: {
        ...updatedUser,
        lastLogin: updatedUser.lastLogin?.toISOString() || null,
        createdAt: updatedUser.createdAt.toISOString(),
        updatedAt: updatedUser.updatedAt.toISOString(),
      }
    });
  } catch (error: any) {
    console.error('Failed to update user:', error);
    return c.json<ErrorResponse>({ error: 'Failed to update user' }, 500);
  }
});

app.delete('/api/admin/users/:id', adminMiddleware, async (c) => {
  try {
    const userId = c.req.param('id');
    const currentUser = c.get('user');
    
    // Prevent self-deletion
    if (userId === currentUser.id) {
      return c.json<ErrorResponse>({ error: 'Cannot delete your own account' }, 400);
    }
    
    // Validate the user exists
    const prisma = DatabaseConnection.getClient();
    const existingUser = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!existingUser) {
      return c.json<ErrorResponse>({ error: 'User not found' }, 404);
    }
    
    // Delete the user
    await prisma.user.delete({
      where: { id: userId }
    });
    
    return c.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error: any) {
    console.error('Failed to delete user:', error);
    return c.json<ErrorResponse>({ error: 'Failed to delete user' }, 500);
  }
});

// Admin OAuth configuration endpoint (read-only)
app.get('/api/admin/oauth/config', adminMiddleware, async (c) => {
  try {
    // Get OAuth configuration from environment
    const allowedDomainsEnv = process.env.OAUTH_ALLOWED_DOMAINS || '';
    const allowedDomains = allowedDomainsEnv
      .split(',')
      .map(d => d.trim())
      .filter(d => d.length > 0);
    
    // Check which providers are configured
    const providers = [];
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      providers.push({
        name: 'google',
        isConfigured: true,
        clientId: process.env.GOOGLE_CLIENT_ID.substring(0, 20) + '...'
      });
    }
    
    return c.json({
      providers,
      allowedDomains
    });
  } catch (error: any) {
    console.error('Failed to fetch OAuth config:', error);
    return c.json<ErrorResponse>({ error: 'Failed to fetch OAuth configuration' }, 500);
  }
});


// Health check endpoint
app.get('/api/health', async (c) => {
  // Check if startup script had issues (for internal monitoring)
  let startupFailed = false;
  try {
    const fs = await import('fs');
    if (fs.existsSync('/tmp/startup_status')) {
      const startupStatus = fs.readFileSync('/tmp/startup_status', 'utf-8').trim();
      if (startupStatus.startsWith('FAILED')) {
        startupFailed = true;
        // Log internally but don't expose details
        console.error('Startup script failure detected:', startupStatus);
      }
    }
  } catch (e) {
    // Ignore file read errors
  }

  if (startupFailed) {
    // Return unhealthy but don't expose internal details
    return c.json<HealthResponse>({ 
      status: 'offline',
      message: 'Service initialization failed',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      database: 'unknown',
      environment: CONFIG.NODE_ENV
    }, 500);
  }

  let dbStatus: 'connected' | 'disconnected' | 'unknown' = 'unknown';
  try {
    const prisma = DatabaseConnection.getClient();
    await prisma.$queryRaw<unknown[]>`SELECT 1`;
    dbStatus = 'connected';
  } catch (error) {
    dbStatus = 'disconnected';
  }

  return c.json<HealthResponse>({ 
    status: 'operational', 
    message: 'Semiont API is running',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    environment: CONFIG.NODE_ENV
  });
});


// Start server
const port = CONFIG.PORT;

console.log(`🚀 Starting Semiont Backend...`);
console.log(`Environment: ${CONFIG.NODE_ENV}`);
console.log(`Port: ${port}`);

// Start server
if (CONFIG.NODE_ENV !== 'test') {
  console.log('🚀 Starting HTTP server...');
}

// Only start server if not in test environment
if (CONFIG.NODE_ENV !== 'test') {
  serve({
    fetch: app.fetch,
    port: port,
    hostname: '0.0.0.0'
  }, (info) => {
    console.log(`🚀 Server ready at http://localhost:${info.port}`);
    console.log(`📡 API ready at http://localhost:${info.port}/api`);
  });
}

export type AppType = typeof app;

// Export app for testing
export { app };