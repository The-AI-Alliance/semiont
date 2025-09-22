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
import { authRouter } from './routes/auth';
import { statusRouter } from './routes/status';
import { adminRouter } from './routes/admin';
import { documentsRouter } from './routes/documents';
import { selectionsRouter } from './routes/selections';

// Import OpenAPI config
import { openApiConfig } from './openapi';

// Import graph database for initialization
import { getGraphDatabase } from './graph/factory';

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
          details: result.error.issues,
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

// Add request/response logging middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const url = c.req.url;
  
  console.log(`[${new Date().toISOString()}] --> ${method} ${url}`);
  
  // Log request body for POST/PUT requests
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      const body = await c.req.raw.clone().json();
      console.log(`    Request body:`, JSON.stringify(body, null, 2));
    } catch (e) {
      // Body might not be JSON or might be empty
    }
  }
  
  await next();
  
  const duration = Date.now() - start;
  const status = c.res.status;
  console.log(`[${new Date().toISOString()}] <-- ${method} ${url} ${status} (${duration}ms)`);
});

// Mount route routers
app.route('/', healthRouter);
app.route('/', authRouter);
app.route('/', statusRouter);
app.route('/', adminRouter);
app.route('/', documentsRouter);
app.route('/', selectionsRouter);

// Test inference route
app.get('/api/test-inference', async (c) => {
  const { getInferenceClient, getInferenceModel } = await import('./inference/factory');
  const client = await getInferenceClient();

  if (!client) {
    return c.json({
      status: 'error',
      message: 'Inference not configured',
      env: {
        SEMIONT_ENV: process.env.SEMIONT_ENV,
        SEMIONT_ROOT: process.env.SEMIONT_ROOT,
        hasApiKey: !!process.env.ANTHROPIC_API_KEY
      }
    }, 500);
  }

  try {
    const response = await client.messages.create({
      model: getInferenceModel(),
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: 'Say "hello"'
      }]
    });

    return c.json({
      status: 'success',
      response: response.content[0],
      model: getInferenceModel()
    });
  } catch (error: any) {
    return c.json({
      status: 'error',
      message: error.message
    }, 500);
  }
});



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
  }, async (info) => {
    console.log(`🚀 Server ready at http://localhost:${info.port}`);
    console.log(`📡 API ready at http://localhost:${info.port}/api`);
    
    // Initialize graph database and seed tag collections
    try {
      console.log('🔧 Initializing graph database...');
      const graphDb = await getGraphDatabase();
      
      // Pre-populate tag collections by calling getters
      // This ensures defaults are loaded on startup
      const entityTypes = await graphDb.getEntityTypes();
      const referenceTypes = await graphDb.getReferenceTypes();
      
      console.log(`✅ Graph database initialized with ${entityTypes.length} entity types and ${referenceTypes.length} reference types`);
    } catch (error) {
      console.error('⚠️ Failed to initialize graph database:', error);
      // Continue running even if graph initialization fails
    }
  });
}

export type AppType = typeof app;

// Export app for testing
export { app };