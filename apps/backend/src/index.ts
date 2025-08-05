import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { prisma } from './db';
import { OAuthService } from './auth/oauth';
import { authMiddleware } from './middleware/auth';
import { User } from '@prisma/client';
import { CONFIG } from './config';
import {
  AuthResponse,
  UserResponse,
  ErrorResponse,
  HelloResponse,
  StatusResponse,
  HealthResponse,
  LogoutResponse,
  LegacyHealthResponse
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

// Hello endpoints
app.get('/api/hello/:name?', (c) => {
  const params = { name: c.req.param('name') };
  
  // Validate parameters
  const validation = validateData(HelloParamsSchema, params);
  if (!validation.success) {
    return c.json<ErrorResponse>({ 
      error: 'Invalid parameters', 
      details: validation.details 
    }, 400);
  }
  
  const name = validation.data.name || 'World';
  
  return c.json<HelloResponse>({
    message: `Hello, ${name}! Welcome to Semiont.`,
    timestamp: new Date().toISOString(),
    platform: 'Semiont Semantic Knowledge Platform',
  });
});

app.get('/api/status', (c) => {
  return c.json<StatusResponse>({
    status: 'operational',
    version: '0.1.0',
    features: {
      semanticContent: 'planned',
      collaboration: 'planned',
      rbac: 'planned',
    },
    message: 'Ready to build the future of knowledge management!',
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
    
    const { access_token } = validation.data;

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

app.get('/api/auth/me', authMiddleware, async (c) => {
  const user = c.get('user');
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

app.post('/api/auth/logout', authMiddleware, async (c) => {
  // For stateless JWT, we just return success
  // The client should remove the token
  return c.json<LogoutResponse>({ success: true, message: 'Logged out successfully' });
});

app.post('/api/auth/accept-terms', authMiddleware, async (c) => {
  const user = c.get('user');
  
  try {
    // Update user's terms acceptance timestamp
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

// Admin middleware - ensures user is authenticated and is an admin
const adminMiddleware = async (c: any, next: any) => {
  // First run auth middleware
  await authMiddleware(c, async () => {});
  
  const user = c.get('user');
  if (!user.isAdmin) {
    return c.json({ error: 'Admin access required' }, 403);
  }
  
  await next();
};

// Admin user management routes
app.get('/api/admin/users', adminMiddleware, async (c) => {
  try {
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

// API Documentation endpoint - Updated 2025-08-01
app.get('/api', (c) => {
  const acceptHeader = c.req.header('Accept') || '';
  const userAgent = c.req.header('User-Agent') || '';
  
  // If request is from a browser (not API client), serve HTML documentation
  if (acceptHeader.includes('text/html') || userAgent.includes('Mozilla')) {
    const baseUrl = `${c.req.url.split('/api')[0]}/api`;
    
    const htmlDoc = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Semiont API Documentation</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            line-height: 1.6; 
            max-width: 1200px; 
            margin: 0 auto; 
            padding: 20px; 
            background: #f8f9fa;
        }
        .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 30px; }
        h3 { color: #7f8c8d; }
        .endpoint { 
            background: #f8f9fa; 
            padding: 15px; 
            margin: 10px 0; 
            border-radius: 6px; 
            border-left: 4px solid #3498db;
        }
        .method { 
            font-weight: bold; 
            padding: 4px 8px; 
            border-radius: 4px; 
            font-size: 0.9em;
            display: inline-block;
            margin-right: 10px;
        }
        .get { background: #d5f4e6; color: #27ae60; }
        .post { background: #fdeaa7; color: #f39c12; }
        .patch { background: #fdcb6e; color: #e17055; }
        .delete { background: #fab1a0; color: #e17055; }
        .auth-required { color: #e74c3c; font-size: 0.9em; }
        .code { 
            background: #2c3e50; 
            color: #ecf0f1; 
            padding: 15px; 
            border-radius: 6px; 
            overflow-x: auto; 
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.9em;
        }
        .model { background: #ecf0f1; padding: 10px; border-radius: 4px; margin: 5px 0; }
        .note { background: #e8f4f8; padding: 15px; border-radius: 6px; border-left: 4px solid #3498db; }
        ul { padding-left: 20px; }
        li { margin: 5px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Semiont API Documentation</h1>
        <p><strong>Version:</strong> 0.1.0</p>
        <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
        <p>REST API for the Semiont Semantic Knowledge Platform</p>

        <div class="note">
            <h3>🔐 Authentication</h3>
            <p><strong>Type:</strong> Bearer Token (JWT)</p>
            <p><strong>Header:</strong> <code>Authorization: Bearer &lt;token&gt;</code></p>
            <p><strong>How to get token:</strong> Use <code>POST /api/auth/google</code> with Google OAuth access token</p>
        </div>

        <h2>📡 Public Endpoints</h2>
        
        <div class="endpoint">
            <span class="method get">GET</span><strong>/api</strong>
            <p>This API documentation (JSON format for API clients, HTML for browsers)</p>
        </div>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/api/hello/:name?</strong>
            <p>Hello world endpoint with optional name parameter</p>
            <p><strong>Parameters:</strong> name (optional, max 100 characters)</p>
        </div>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/api/status</strong>
            <p>Service status and feature availability</p>
        </div>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/api/health</strong>
            <p>Health check with database connectivity status</p>
        </div>

        <h2>🔑 Authentication Endpoints</h2>

        <div class="endpoint">
            <span class="method post">POST</span><strong>/api/auth/google</strong>
            <p>Authenticate with Google OAuth and receive JWT token</p>
            <p><strong>Body:</strong> <code>{ "access_token": "your-google-oauth-token" }</code></p>
        </div>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/api/auth/me</strong>
            <span class="auth-required">🔒 Authentication required</span>
            <p>Get current authenticated user information</p>
        </div>

        <div class="endpoint">
            <span class="method post">POST</span><strong>/api/auth/logout</strong>
            <span class="auth-required">🔒 Authentication required</span>
            <p>Logout (stateless - client should discard token)</p>
        </div>

        <h2>👑 Admin Endpoints</h2>
        <p class="auth-required">All admin endpoints require authentication + admin privileges</p>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/api/admin/users</strong>
            <span class="auth-required">🔒 Admin only</span>
            <p>List all users with their details and metadata</p>
        </div>

        <div class="endpoint">
            <span class="method get">GET</span><strong>/api/admin/users/stats</strong>
            <span class="auth-required">🔒 Admin only</span>
            <p>Get user statistics (total, active, admins, recent registrations)</p>
        </div>

        <div class="endpoint">
            <span class="method patch">PATCH</span><strong>/api/admin/users/:id</strong>
            <span class="auth-required">🔒 Admin only</span>
            <p>Update user properties (admin status, active status, name)</p>
            <p><strong>Body:</strong> <code>{ "isAdmin": boolean, "isActive": boolean, "name": string }</code></p>
        </div>

        <div class="endpoint">
            <span class="method delete">DELETE</span><strong>/api/admin/users/:id</strong>
            <span class="auth-required">🔒 Admin only</span>
            <p>Delete user account (cannot delete own account)</p>
        </div>

        <h2>📝 Usage Examples</h2>

        <h3>Authentication Flow</h3>
        <ol>
            <li>Get Google OAuth access token from your frontend</li>
            <li>POST to <code>/api/auth/google</code> with <code>{ "access_token": "your-token" }</code></li>
            <li>Extract the 'token' from response</li>
            <li>Include in subsequent requests: <code>Authorization: Bearer &lt;token&gt;</code></li>
        </ol>

        <h3>Example API Call</h3>
        <div class="code">curl -X GET ${baseUrl}/auth/me \\<br>
  -H "Authorization: Bearer YOUR_JWT_TOKEN"</div>

        <h3>Admin User Management</h3>
        <div class="code">curl -X PATCH ${baseUrl}/admin/users/USER_ID \\<br>
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN" \\<br>
  -H "Content-Type: application/json" \\<br>
  -d '{"isAdmin": true, "isActive": true}'</div>

        <h2>🏗️ Data Models</h2>

        <div class="model">
            <h3>User Object</h3>
            <ul>
                <li><code>id</code> - string: Unique user identifier</li>
                <li><code>email</code> - string: User email address</li>
                <li><code>name</code> - string | null: Display name</li>
                <li><code>image</code> - string | null: Profile image URL</li>
                <li><code>domain</code> - string: Email domain</li>
                <li><code>provider</code> - string: OAuth provider (google)</li>
                <li><code>isAdmin</code> - boolean: Admin privileges</li>
                <li><code>isActive</code> - boolean: Account status</li>
                <li><code>lastLogin</code> - string | null: ISO timestamp</li>
                <li><code>createdAt</code> - string: ISO timestamp</li>
            </ul>
        </div>

        <h2>⚠️ Error Codes</h2>
        <ul>
            <li><strong>400</strong> - Bad Request: Invalid request body or parameters</li>
            <li><strong>401</strong> - Unauthorized: Missing or invalid authentication token</li>
            <li><strong>403</strong> - Forbidden: Valid token but insufficient privileges</li>
            <li><strong>404</strong> - Not Found: Resource does not exist</li>
            <li><strong>500</strong> - Internal Server Error: Server-side error occurred</li>
        </ul>

        <div class="note">
            <h3>📋 Notes</h3>
            <ul>
                <li>JWT tokens expire after 7 days</li>
                <li>CORS enabled for configured frontend domains</li>
                <li>No rate limiting currently implemented</li>
                <li>This is a development API - schema may change</li>
            </ul>
        </div>

        <hr>
        <p style="text-align: center; color: #7f8c8d; margin-top: 30px;">
            📡 For JSON format, make API requests with <code>Accept: application/json</code> header
        </p>
    </div>
</body>
</html>`;
    
    return c.html(htmlDoc);
  }

  // For API clients, return JSON documentation
  const apiDocs = {
    name: "Semiont API",
    version: "0.1.0",
    description: "REST API for the Semiont Semantic Knowledge Platform",
    baseUrl: `${c.req.url.split('/api')[0]}/api`,
    authentication: {
      type: "Bearer Token (JWT)",
      header: "Authorization: Bearer <token>",
      howToGetToken: "Use POST /api/auth/google with Google OAuth access token"
    },
    endpoints: {
      // Public Endpoints
      public: {
        "GET /api": {
          description: "This API documentation",
          parameters: "none",
          response: "API documentation object"
        },
        "GET /api/hello/:name?": {
          description: "Hello world endpoint with optional name parameter",
          parameters: {
            name: "optional string, max 100 characters"
          },
          response: "HelloResponse with personalized greeting"
        },
        "GET /api/status": {
          description: "Service status and feature availability",
          parameters: "none",
          response: "StatusResponse with platform status"
        },
        "GET /api/health": {
          description: "Health check with database connectivity",
          parameters: "none",
          response: "HealthResponse with service health"
        },
        "GET /health": {
          description: "Legacy health check endpoint",
          parameters: "none",
          response: "LegacyHealthResponse (for backward compatibility)"
        }
      },
      
      // Authentication Endpoints
      auth: {
        "POST /api/auth/google": {
          description: "Authenticate with Google OAuth",
          authentication: "none",
          body: {
            access_token: "string (required) - Google OAuth access token"
          },
          response: "AuthResponse with user info and JWT token"
        },
        "GET /api/auth/me": {
          description: "Get current authenticated user information",
          authentication: "Bearer token required",
          parameters: "none",
          response: "UserResponse with current user details"
        },
        "POST /api/auth/logout": {
          description: "Logout (stateless - client should discard token)",
          authentication: "Bearer token required",
          parameters: "none",
          response: "LogoutResponse with success confirmation"
        }
      },
      
      // Admin Endpoints (require admin privileges)
      admin: {
        "GET /api/admin/users": {
          description: "List all users (admin only)",
          authentication: "Bearer token required + admin privileges",
          parameters: "none",
          response: "Array of user objects with metadata"
        },
        "GET /api/admin/users/stats": {
          description: "Get user statistics (admin only)",
          authentication: "Bearer token required + admin privileges",
          parameters: "none",
          response: "User statistics object (total, active, admins, recent)"
        },
        "PATCH /api/admin/users/:id": {
          description: "Update user properties (admin only)",
          authentication: "Bearer token required + admin privileges",
          parameters: {
            id: "string (required) - User ID in URL path"
          },
          body: {
            isAdmin: "boolean (optional) - Set admin status",
            isActive: "boolean (optional) - Set active status",
            name: "string (optional) - Update display name"
          },
          response: "Updated user object"
        },
        "DELETE /api/admin/users/:id": {
          description: "Delete user account (admin only)",
          authentication: "Bearer token required + admin privileges",
          parameters: {
            id: "string (required) - User ID in URL path"
          },
          response: "Success confirmation (cannot delete own account)"
        }
      }
    },
    
    // Data Models
    models: {
      User: {
        id: "string - Unique user identifier",
        email: "string - User email address",
        name: "string | null - Display name",
        image: "string | null - Profile image URL",
        domain: "string - Email domain",
        provider: "string - OAuth provider (google)",
        isAdmin: "boolean - Admin privileges",
        isActive: "boolean - Account status",
        lastLogin: "string | null - ISO timestamp",
        createdAt: "string - ISO timestamp",
        updatedAt: "string - ISO timestamp"
      },
      ErrorResponse: {
        error: "string - Error message",
        code: "string (optional) - Error code",
        details: "object (optional) - Additional error details"
      }
    },
    
    // Usage Examples
    examples: {
      authentication: {
        description: "How to authenticate and make API calls",
        steps: [
          "1. Get Google OAuth access token from your frontend",
          "2. POST to /api/auth/google with { access_token: 'your-token' }",
          "3. Extract the 'token' from response",
          "4. Include in subsequent requests: Authorization: Bearer <token>"
        ],
        curlExample: `curl -X GET ${c.req.url.split('/api')[0]}/api/auth/me \\
  -H "Authorization: Bearer YOUR_JWT_TOKEN"`
      },
      adminOperations: {
        description: "Admin user management examples",
        listUsers: `curl -X GET ${c.req.url.split('/api')[0]}/api/admin/users \\
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN"`,
        updateUser: `curl -X PATCH ${c.req.url.split('/api')[0]}/api/admin/users/USER_ID \\
  -H "Authorization: Bearer YOUR_ADMIN_JWT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"isAdmin": true, "isActive": true}'`
      }
    },
    
    // Error Codes
    errorCodes: {
      400: "Bad Request - Invalid request body or parameters",
      401: "Unauthorized - Missing or invalid authentication token",
      403: "Forbidden - Valid token but insufficient privileges (admin required)",
      404: "Not Found - Resource does not exist",
      500: "Internal Server Error - Server-side error occurred"
    },
    
    // Rate Limiting & Notes
    notes: {
      rateLimit: "No rate limiting currently implemented",
      cors: "CORS enabled for configured frontend domains",
      tokenExpiry: "JWT tokens expire after 7 days",
      development: "This is a development API - schema may change"
    }
  };
  
  return c.json(apiDocs);
});

// Health check endpoint
app.get('/api/health', async (c) => {
  let dbStatus: 'connected' | 'disconnected' | 'unknown' = 'unknown';
  try {
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

// Legacy health check (for backward compatibility)
app.get('/health', (c) => {
  return c.json<LegacyHealthResponse>({ status: 'ok', message: 'Semiont API is running' });
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
    execSync('npx prisma db push', { stdio: 'inherit' });
    console.log('✅ Database migrations completed');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    // Don't exit - let the server try to start anyway
  }
}

// Run migrations before starting server
runMigrations().then(() => {
  console.log('🚀 Starting HTTP server...');
});

serve({
  fetch: app.fetch,
  port: port,
  hostname: '0.0.0.0'
}, (info) => {
  console.log(`🚀 Server ready at http://localhost:${info.port}`);
  console.log(`📡 API ready at http://localhost:${info.port}/api`);
});

export type AppType = typeof app;

// Export app for testing
export { app };