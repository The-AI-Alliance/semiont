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

import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';

import { User } from '@prisma/client';

// Configuration is loaded in JWT service when needed
// For the server itself, we use environment variables
const CONFIG = {
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 4000,
};

// Import route definitions
import { healthRouter } from './routes/health';
import { helloRouter } from './routes/hello';
import { authRouter } from './routes/auth';
import { statusRouter } from './routes/status';
import { adminRouter } from './routes/admin';

// Import OpenAPI config
import { openApiConfig } from './openapi';

type Variables = {
  user: User;
};

// Create OpenAPIHono app with proper typing
const app = new OpenAPIHono<{ Variables: Variables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: 'Validation error',
          details: result.error.errors,
        },
        400
      );
    }
    return undefined;
  },
});

// Add CORS middleware
app.use('*', cors({
  origin: CONFIG.CORS_ORIGIN || CONFIG.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

// Mount route routers
app.route('/', healthRouter);
app.route('/', helloRouter);
app.route('/', authRouter);
app.route('/', statusRouter);
app.route('/', adminRouter);



// API Documentation root - redirect to appropriate format
app.get('/api', (c) => {
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

// Serve OpenAPI JSON specification - now automatically generated
app.get('/api/openapi.json', (c) => {
  return c.json(app.getOpenAPI31Document({
    ...openApiConfig,
    servers: [
      {
        url: process.env.API_URL || 'http://localhost:4000',
        description: 'API Server',
      },
    ],
  }));
});

// Serve Swagger UI documentation - now public
app.get('/api/docs', async (c) => {
  // Token is optional for authenticated access
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
app.get('/api/swagger', (c) => {
  const token = c.req.query('token');
  const redirectUrl = token ? `/api/docs?token=${token}` : '/api/docs';
  return c.redirect(redirectUrl);
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