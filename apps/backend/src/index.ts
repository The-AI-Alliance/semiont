// Construct DATABASE_URL from components if not already set
// MUST be done before any Prisma imports!
if (!process.env.DATABASE_URL && process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD) {
  const dbPort = process.env.DB_PORT;
  const dbName = process.env.DB_NAME;

  if (!dbPort) {
    throw new Error('DB_PORT is required when constructing DATABASE_URL from components');
  }
  if (!dbName) {
    throw new Error('DB_NAME is required when constructing DATABASE_URL from components');
  }

  const url = new URL('postgresql://localhost');
  url.username = process.env.DB_USER;
  url.password = process.env.DB_PASSWORD; // Automatically URL-encoded by URL class
  url.hostname = process.env.DB_HOST;
  url.port = dbPort;
  url.pathname = `/${dbName}`;
  url.searchParams.set('sslmode', 'require');

  process.env.DATABASE_URL = url.toString();
  console.log('✅ DATABASE_URL constructed from components');
}

import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { loadEnvironmentConfig, findProjectRoot, type EnvironmentConfig } from '@semiont/core';

import { User } from '@prisma/client';

// Load configuration from semiont.json + environments/{SEMIONT_ENV}.json
// SEMIONT_ROOT and SEMIONT_ENV are read from environment
const env = process.env.SEMIONT_ENV || 'local';
const projectRoot = findProjectRoot();
const config = loadEnvironmentConfig(projectRoot, env);

if (!config.services?.backend) {
  throw new Error('services.backend is required in environment config');
}
if (!config.services.backend.corsOrigin) {
  throw new Error('services.backend.corsOrigin is required in environment config');
}
if (!config.services?.frontend?.url) {
  throw new Error('services.frontend.url is required in environment config');
}

const backendService = config.services.backend;

// Import route definitions
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { statusRouter } from './routes/status';
import { adminRouter } from './routes/admin';
import { resourcesRouter } from './routes/resources/index';
import { annotationsRouter } from './routes/annotations/index';
import { entityTypesRouter } from './routes/entity-types';
import { jobsRouter } from './routes/jobs/index';

// Import static OpenAPI spec
import * as fs from 'fs';
import * as path from 'path';

// Import graph database for initialization
import { getGraphDatabase } from './graph/factory';
// Import inference client for initialization
import { getInferenceClient } from './inference/factory';
// Import security headers middleware
import { securityHeaders } from './middleware/security-headers';

type Variables = {
  user: User;
  config: EnvironmentConfig;
};

// Create Hono app with proper typing
const app = new Hono<{ Variables: Variables }>();

// Add CORS middleware
app.use('*', cors({
  origin: backendService.corsOrigin,
  credentials: true,
}));

// Add security headers middleware (after CORS, before other middleware)
app.use('*', securityHeaders());

// Inject config into context for all routes
app.use('*', async (c, next) => {
  c.set('config', config);
  await next();
});

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
app.route('/', resourcesRouter);
app.route('/', annotationsRouter);
app.route('/', entityTypesRouter);
app.route('/', jobsRouter);

// API Resourceation root - redirect to appropriate format
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
  // Serve the static OpenAPI spec from the specs directory
  const openApiPath = path.join(__dirname, '../../../specs/openapi.json');
  const openApiContent = fs.readFileSync(openApiPath, 'utf-8');
  const openApiSpec = JSON.parse(openApiContent);

  // Update server URL dynamically
  const port = backendService.port || 4000;
  const apiUrl = backendService.publicURL || `http://localhost:${port}`;
  if (apiUrl) {
    openApiSpec.servers = [
      {
        url: apiUrl,
        description: 'API Server',
      },
    ];
  }

  return c.json(openApiSpec);
});

// Serve Swagger UI resourceation - now public
app.get('/api/docs', async (c) => {
  // Token is optional for authenticated access
  const token = c.req.query('token');
  
  try {
    const swaggerHandler = swaggerUI({ 
      url: token ? `/api/openapi.json?token=${token}` : '/api/openapi.json',
      persistAuthorization: true,
      title: 'Semiont API Resourceation'
    });
    
    // TypeScript workarounds: swaggerUI has type mismatches
    // - It's typed as MiddlewareHandler expecting (c, next) but runtime only uses (c)
    // - Context type incompatibility requires 'as any' cast
    return await swaggerHandler(c as any, async () => {});
  } catch (error) {
    console.error('Error in /api/docs handler:', error);
    return c.json({ error: 'Failed to load resourceation', details: String(error) }, 500);
  }
});

// Redirect /api/swagger to /api/docs for convenience
app.get('/api/swagger', (c) => {
  const token = c.req.query('token');
  const redirectUrl = token ? `/api/docs?token=${token}` : '/api/docs';
  return c.redirect(redirectUrl);
});

// 404 handler for non-existent API routes
app.all('/api/*', (c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Start server
const port = backendService.port || 4000;
const nodeEnv = config.env?.NODE_ENV || 'development';

console.log(`🚀 Starting Semiont Backend...`);
console.log(`Environment: ${nodeEnv}`);
console.log(`Port: ${port}`);

// Start server
if (nodeEnv !== 'test') {
  console.log('🚀 Starting HTTP server...');
}

// Only start server if not in test environment
if (nodeEnv !== 'test') {
  serve({
    fetch: app.fetch,
    port: port,
    hostname: '0.0.0.0'
  }, async (info) => {
    console.log(`🚀 Server ready at http://localhost:${info.port}`);
    console.log(`📡 API ready at http://localhost:${info.port}/api`);

    // Initialize JWT Service with configuration
    try {
      console.log('🔐 Initializing JWT Service...');
      const { JWTService } = await import('./auth/jwt');
      JWTService.initialize(config);
      console.log('✅ JWT Service initialized');
    } catch (error) {
      console.error('⚠️ Failed to initialize JWT Service:', error);
      // Continue running even if JWT initialization fails
    }

    // Bootstrap entity types projection if it doesn't exist
    try {
      console.log('🌱 Bootstrapping entity types...');
      const { bootstrapEntityTypes } = await import('./bootstrap/entity-types-bootstrap');
      await bootstrapEntityTypes(config);
      console.log('✅ Entity types bootstrap complete');
    } catch (error) {
      console.error('⚠️ Failed to bootstrap entity types:', error);
      // Continue running even if bootstrap fails
    }

    // Initialize graph database and seed tag collections
    try {
      console.log('🔧 Initializing graph database...');
      const graphDb = await getGraphDatabase(config);

      // Pre-populate tag collections by calling getters
      // This ensures defaults are loaded on startup
      const entityTypes = await graphDb.getEntityTypes();

      console.log(`✅ Graph database initialized with ${entityTypes.length} entity types`);
    } catch (error) {
      console.error('⚠️ Failed to initialize graph database:', error);
      // Continue running even if graph initialization fails
    }

    // Initialize inference client
    try {
      console.log('🤖 Initializing inference client...');
      await getInferenceClient(config);
      console.log('✅ Inference client initialized');
    } catch (error) {
      console.error('⚠️ Failed to initialize inference client:', error);
      // Continue running even if inference initialization fails
    }

    // Initialize GraphDB consumer (syncs from Event Store views)
    try {
      console.log('📊 Starting GraphDB consumer...');
      const { startGraphConsumer } = await import('./events/consumers/graph-consumer');
      await startGraphConsumer(config);
      console.log('✅ GraphDB consumer started');
    } catch (error) {
      console.error('⚠️ Failed to start GraphDB consumer:', error);
      // Continue running even if consumer fails to start
    }

    // Initialize Job Queue
    try {
      console.log('💼 Initializing job queue...');
      const { initializeJobQueue } = await import('./jobs/job-queue');
      const dataDir = config.services?.filesystem?.path || process.env.DATA_DIR || './data';
      if (!dataDir) {
        throw new Error('services.filesystem.path is required in environment config for job queue initialization');
      }
      await initializeJobQueue({ dataDir });
      console.log('✅ Job queue initialized');
    } catch (error) {
      console.error('⚠️ Failed to initialize job queue:', error);
    }

    // Start Job Workers
    try {
      console.log('👷 Starting job workers...');
      const { DetectionWorker } = await import('./jobs/workers/detection-worker');
      const { GenerationWorker } = await import('./jobs/workers/generation-worker');
      const { HighlightDetectionWorker } = await import('./jobs/workers/highlight-detection-worker');
      const { AssessmentDetectionWorker } = await import('./jobs/workers/assessment-detection-worker');
      const { CommentDetectionWorker } = await import('./jobs/workers/comment-detection-worker');

      const detectionWorker = new DetectionWorker(config);
      const generationWorker = new GenerationWorker(config);
      const highlightDetectionWorker = new HighlightDetectionWorker(config);
      const assessmentDetectionWorker = new AssessmentDetectionWorker(config);
      const commentDetectionWorker = new CommentDetectionWorker(config);

      // Start workers in background (non-blocking)
      detectionWorker.start().catch((error) => {
        console.error('⚠️ Detection worker stopped with error:', error);
      });

      generationWorker.start().catch((error) => {
        console.error('⚠️ Generation worker stopped with error:', error);
      });

      highlightDetectionWorker.start().catch((error) => {
        console.error('⚠️ Highlight detection worker stopped with error:', error);
      });

      assessmentDetectionWorker.start().catch((error) => {
        console.error('⚠️ Assessment detection worker stopped with error:', error);
      });

      commentDetectionWorker.start().catch((error) => {
        console.error('⚠️ Comment detection worker stopped with error:', error);
      });

      console.log('✅ Detection worker started');
      console.log('✅ Generation worker started');
      console.log('✅ Highlight detection worker started');
      console.log('✅ Assessment detection worker started');

    } catch (error) {
      console.error('⚠️ Failed to start job workers:', error);
    }
  });
}

export type AppType = typeof app;

// Export app for testing
export { app };