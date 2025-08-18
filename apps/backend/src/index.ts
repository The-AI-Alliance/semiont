import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { DatabaseConnection } from './db';
import { OAuthService } from './auth/oauth';
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

// Public endpoints - these don't require authentication
const PUBLIC_ENDPOINTS = [
  '/api/health',          // Required for ALB health checks
  '/api/auth/google',     // OAuth login initiation
  // '/api/auth/callback',   // OAuth callback (reserved for future backend OAuth flow)
  '/api',                 // API documentation root
  '/api/openapi.json',    // OpenAPI specification
  '/api/docs',            // Swagger UI documentation
  '/api/swagger'          // Swagger UI redirect
];

// Apply authentication middleware to all /api/* routes except public endpoints
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  
  // Check if this is a public endpoint
  if (PUBLIC_ENDPOINTS.some(endpoint => path === endpoint || path.startsWith(endpoint + '/'))) {
    return next();
  }
  
  // All other endpoints require authentication
  // Note: authMiddleware will handle the actual auth check
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

app.get('/api/auth/me', async (c) => {
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

app.post('/api/auth/logout', async (c) => {
  // Auth already applied globally
  // For stateless JWT, we just return success
  // The client should remove the token
  return c.json<LogoutResponse>({ success: true, message: 'Logged out successfully' });
});

app.post('/api/auth/accept-terms', async (c) => {
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

// API Documentation endpoint - Redirect to OpenAPI/Swagger UI
app.get('/api', (c) => {
  const acceptHeader = c.req.header('Accept') || '';
  const userAgent = c.req.header('User-Agent') || '';
  
  // If request is from a browser, redirect to Swagger UI
  if (acceptHeader.includes('text/html') || userAgent.includes('Mozilla')) {
    return c.redirect('/api/docs');
  }

  // For API clients requesting JSON, redirect to OpenAPI spec
  return c.redirect('/api/openapi.json');
});

// Create OpenAPI documentation app
const openAPIApp = new OpenAPIHono();

// Register all route definitions for documentation
Object.values(routes).forEach(route => {
  // We're only using this for documentation generation, not actual routing
  openAPIApp.openapi(route, async () => new Response());
});

// Generate OpenAPI specification
const openApiSpec = openAPIApp.getOpenAPI31Document(openApiConfig);

// Serve OpenAPI JSON specification
app.get('/api/openapi.json', (c) => {
  return c.json(openApiSpec);
});

// Serve Swagger UI documentation
app.get('/api/docs', swaggerUI({ 
  url: '/api/openapi.json',
  persistAuthorization: true,
}));

// Redirect /api/swagger to /api/docs for convenience
app.get('/api/swagger', (c) => {
  return c.redirect('/api/docs');
});

// Health check endpoint
app.get('/api/health', async (c) => {
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

// Run database migrations on startup
async function runMigrations() {
  try {
    console.log('📝 Running database migrations...');
    const { execSync } = require('child_process');
    execSync('npx prisma db push', { 
      stdio: 'inherit',
      env: { ...process.env }  // Pass all environment variables including DATABASE_URL
    });
    console.log('✅ Database migrations completed');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    // Don't exit - let the server try to start anyway
  }
}

// Run migrations before starting server (skip in test environment)
if (CONFIG.NODE_ENV !== 'test') {
  runMigrations().then(() => {
    console.log('🚀 Starting HTTP server...');
  });
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