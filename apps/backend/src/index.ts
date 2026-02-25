// Environment variables are loaded via Node's --env-file flag (see package.json)
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
  // Note: Logger not yet initialized at this point, using console
  console.log('DATABASE_URL constructed from components');
}

import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { type EnvironmentConfig, EventBus } from '@semiont/core';
import { startMakeMeaning } from '@semiont/make-meaning';
import { loadEnvironmentConfig } from './utils/config';

import { User } from '@prisma/client';

// Load configuration from semiont.json + environments/{SEMIONT_ENV}.json
// SEMIONT_ROOT and SEMIONT_ENV are read from environment
const env = process.env.SEMIONT_ENV || 'local';
const projectRoot = process.env.SEMIONT_ROOT;
if (!projectRoot) {
  throw new Error('SEMIONT_ROOT environment variable is not set');
}

const config = loadEnvironmentConfig(projectRoot, env);

if (!config.services?.backend) {
  throw new Error('services.backend is required in environment config');
}
if (!config.services.backend.corsOrigin) {
  throw new Error('services.backend.corsOrigin is required in environment config');
}

const backendService = config.services.backend;

// Import logging utilities
import { initializeLogger, getLogger } from './logger';

// Initialize Winston logger with log level from environment config
initializeLogger(config.logLevel);
const logger = getLogger();

// Create global EventBus for real-time events
const eventBus = new EventBus();

// Initialize make-meaning service (job queue, workers, graph consumer)
const makeMeaning = await startMakeMeaning(config, eventBus, logger);

// Import route definitions
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { statusRouter } from './routes/status';
import { adminRouter } from './routes/admin';
import { createResourcesRouter } from './routes/resources/index';
import { annotationsRouter } from './routes/annotations/index';
import { entityTypesRouter } from './routes/entity-types';
import { createJobsRouter } from './routes/jobs/index';
import { authMiddleware } from './middleware/auth';

// Import for static OpenAPI spec
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Graph database and inference client are accessed via makeMeaning service
// Import security headers middleware
import { securityHeaders } from './middleware/security-headers';
// Import logging middleware
import { requestIdMiddleware } from './middleware/request-id';
import { requestLoggerMiddleware } from './middleware/request-logger';
import { errorLoggerMiddleware } from './middleware/error-logger';

type Variables = {
  user: User;
  config: EnvironmentConfig;
  makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
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

// Add logging middleware (order matters!)
app.use('*', requestIdMiddleware);       // Generate request ID first
app.use('*', errorLoggerMiddleware);     // Catch errors second
app.use('*', requestLoggerMiddleware);   // Log requests third

// Inject config and makeMeaning into context for all routes
app.use('*', async (c, next) => {
  c.set('config', config);
  c.set('makeMeaning', makeMeaning);
  await next();
});

// Mount route routers
app.route('/', healthRouter);
app.route('/', authRouter);
app.route('/', statusRouter);
app.route('/', adminRouter);
const resourcesRouter = createResourcesRouter(makeMeaning.jobQueue);
app.route('/', resourcesRouter);
app.route('/', annotationsRouter);
app.route('/', entityTypesRouter);
const jobsRouter = createJobsRouter(makeMeaning.jobQueue, authMiddleware);
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
    logger.error('Error in /api/docs handler', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
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

// Only start server if not in test environment
if (nodeEnv !== 'test') {
  serve({
    fetch: app.fetch,
    port: port,
    hostname: '0.0.0.0'
  }, async (info) => {
    logger.info('Semiont Backend ready', {
      url: `http://localhost:${info.port}/api`,
      environment: nodeEnv
    });

    // Initialize JWT Service with configuration
    try {
      const { JWTService } = await import('./auth/jwt');
      JWTService.initialize(config);
    } catch (error) {
      logger.error('Failed to initialize JWT Service', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }

    // Pre-load entity types from graph database for performance
    try {
      const entityTypes = await makeMeaning.graphDb.getEntityTypes();
      logger.info('Loaded entity types from graph database', {
        count: entityTypes.length
      });
    } catch (error) {
      logger.error('Failed to pre-load entity types', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  });
}

export type AppType = typeof app;

// Export app for testing
export { app };