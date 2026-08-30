// DATABASE_URL arrives already set: the container's CMD derives it from
// services.database (src/cli/db-url.ts) before this process starts, and an
// explicitly-provided one takes precedence over that.
//
// It is deliberately NOT assembled here. A DB_HOST/DB_USER/DB_PASSWORD component
// form used to live at the top of this file, claiming "MUST be done before any
// Prisma imports!" — a requirement it could not meet, for two reasons:
//
//   1. `prisma migrate deploy` runs as a separate process before the server and
//      reads process.env.DATABASE_URL via prisma.config.ts, so it never saw a
//      value assembled in here at all.
//   2. The bundler emits module bodies in dependency order, so src/db.ts's
//      module-scope client construction ran BEFORE this file's top-level code.
//      The adapter got `connectionString: undefined`.
//
// Deriving it outside the process fixes both. Do not reintroduce an in-process
// assembly here without re-checking those two facts.

import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { SemiontState } from '@semiont/core/node';
import { type EnvironmentConfig, EventBus } from '@semiont/core';
import { startMakeMeaningGateway, makeMeaningConfigFrom, requireKBName } from '@semiont/make-meaning';
import { loadEnvironmentConfig } from '@semiont/core/node';

import { User } from '@prisma/client';

// Load configuration from .semiont/config + ~/.semiontconfig (TOML).
// The environment is resolved by the loader from `[defaults] environment` — the
// SAME key the launcher selects from (config.go) — so one config selects it for
// both halves. Nothing is selected here — no environment variable, no 'local'
// default: those disagreed across entry points and silently loaded the wrong
// (empty) section.
// `null`, not a KB root: this process mounts no knowledge base (SINGLE-KB-MOUNT
// P6). Everything it needs — the KB's own committed settings plus the
// launcher's staged `[kb]` identity and archivist topology — arrives in the
// per-service copy the launcher mounts at ~/.semiontconfig, which is exactly
// what the loader reads when given no root. Every sidecar has loaded this way
// since it was extracted; the gateway was the last holdout, and only because
// it still had a tree to read from.
//
// SEMIONT_ROOT and SEMIONT_ANCHORED_TEXT_DIR are gone with the mounts they
// named. The store the second one pointed at belongs to the Smelter
// (ANCHORED-TEXT-TO-SMELTER P1) and the tree the first one pointed at belongs
// to the Archivist; this process reaches both over HTTP.
const config = loadEnvironmentConfig(null);

if (!config.services?.backend) {
  throw new Error('services.backend is required in environment config');
}

// Checked HERE, with the other startup requirements, rather than only in
// JWTService.initialize below: this runs before startMakeMeaning dials the graph
// and vector stores, so a missing secret costs a millisecond instead of a full
// make-meaning startup. Same rule either way — requireJwtSecret is the one copy.
const { requireJwtSecret } = await import('./auth/jwt');
requireJwtSecret();

// ── KB identity (KB-IDENTITY-VS-ADDRESS decisions 8 + 10) ────────────────
//
// One check over two values, because they are two branches of one question —
// "is this knowledge base's identity sound?" — asked of the same pair at the
// same moment. Splitting them into separate passes is how one drifts from
// the other.
//
//   committed  = the launcher-staged `[kb] domain` — the KB's own permanent
//                identity, read off its `.semiont/config` by the launcher,
//                turned into did:web and published, and what /api/status
//                reports.
//   effective  = config.site.domain — what THIS process will mint AGENT dids
//                from (JWTService.getDomainForAgent).
//
// The committed side is the launcher-staged top-level `[kb] domain`
// (SINGLE-KB-MOUNT P5) — read there and NOWHERE else. It used to come off
// this process's own `/kb` mount, which it no longer has. `[site]` remains
// the wrong source for it either way: the TOML loader defaults a domain-less
// `[site]` to the literal 'localhost' and lets an environment section
// override the project's, so it can report an identity the KB never
// declared. `[kb]` sits beside `[defaults]`, out of that reach, and the
// launcher stages NO domain when the KB declares none — so an undeclared
// identity still arrives here as absent, and still refuses below.
{
  const committedDomain = config.kb?.domain;

  // Decision 8 — a knowledge base declares its identity or does not run.
  // `semiont start` already refuses this; a backend launched another way
  // (docker, npm, a script) must refuse too, or /api/status would owe a
  // required `did` it cannot produce. Refusing is what makes that field
  // satisfiable by construction rather than conditionally true.
  if (!committedDomain) {
    throw new Error(
      'This knowledge base declares no identity: [site] domain is missing from its ' +
        '.semiont/config, so the launcher staged no [kb] domain.\n' +
        'A knowledge base declares its identity or does not run — it is permanent, and has no safe default ' +
        "(inferring one from an address is how two KBs end up sharing a fabricated 'did:web:localhost').\n" +
        'Add:\n\n  [site]\n  domain = "your-org.github.io:your-kb-repo"\n',
    );
  }

  // Decision 10 — the agents' domain MAY legitimately differ (a deployment
  // can mint agent identities elsewhere), so this warns rather than refuses.
  // What it must never do is happen silently: the KB would be did:web:A
  // while everything it generates is attributed to did:web:B:agents:… .
  const effectiveDomain = config.site?.domain;
  if (effectiveDomain !== committedDomain) {
    // eslint-disable-next-line no-console
    console.warn(
      `[identity] KB is "${committedDomain}" (committed .semiont/config) but agents will be minted under ` +
        `"${effectiveDomain}" (environment config). The KB's own did is unaffected; only agent identities move. ` +
        'If unintended, remove the `site` section for this environment from the KB\'s ' +
        '`.semiont/semiontconfig/<name>.toml` — that file is the source of truth; inside the container it is ' +
        'only mounted read-only at ~/.semiontconfig, so editing it there does not persist. Note that a ' +
        "`site` section without a `domain` key silently resolves to 'localhost'.",
    );
  }
}

const backendService = config.services.backend;

// Import logging utilities
import { initializeLogger, getLogger } from './logger';

// Initialize Winston logger with log level from environment config
initializeLogger(config.logLevel);
const logger = getLogger();

// Event-loop lag monitor.
// Samples loop delay every 20ms and emits a summary every 30s. If P99 > 100ms,
// incoming HTTP requests are sitting in the TCP backlog instead of being
// handled promptly — that's what surfaces as client-side "Request timed out"
// on otherwise-fast POSTs. Low overhead (<1% CPU).
{
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const monitorLogger = logger.child({ component: 'event-loop-monitor' });
  setInterval(() => {
    const maxMs = Number((h.max / 1e6).toFixed(1));
    const p99Ms = Number((h.percentile(99) / 1e6).toFixed(1));
    const meanMs = Number((h.mean / 1e6).toFixed(1));
    const level = p99Ms > 100 ? 'warn' : 'info';
    monitorLogger.log(level, 'event-loop delay', { meanMs, p99Ms, maxMs });
    h.reset();
  }, 30_000).unref();
}

// Create global EventBus for real-time events
const eventBus = new EventBus();

// The gateway's make-meaning slice: job queue, kb reads, and the handler
// subset — no actors. Actors run in the Archivist and Librarian services.
// A `SemiontState`, not a `SemiontProject`: name + the state-mount paths,
// with no KB root. That is the type-level statement of P5 — the gateway
// cannot reach a tree it does not have, and the compiler enforces it.
const makeMeaning = await startMakeMeaningGateway(
  new SemiontState({ name: requireKBName(config) }),
  makeMeaningConfigFrom(config),
  eventBus,
  logger,
);

// Import route definitions
import { rootRouter } from './routes/root';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { statusRouter } from './routes/status';
import { adminRouter } from './routes/admin';
import { createResourcesRouter } from './routes/resources/index';
import { createBusRouter } from './routes/bus';
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
  eventBus: EventBus;
  makeMeaning: Awaited<ReturnType<typeof startMakeMeaningGateway>>;
};

// Create Hono app with proper typing
const app = new Hono<{ Variables: Variables }>();

// CORS: bearer-only API → literal '*', no credentials (SDK-AUTH-CORS Phase 4).
// '*' is legal precisely because credentials are off; do NOT reflect the
// request origin (the CORS-LOGIN-FIX "echo any origin + credentials" anti-pattern).
app.use('*', cors({ origin: '*' }));

// Add security headers middleware (after CORS, before other middleware)
app.use('*', securityHeaders());

// Add logging middleware (order matters!)
app.use('*', requestIdMiddleware);       // Generate request ID first
app.use('*', errorLoggerMiddleware);     // Catch errors second
app.use('*', requestLoggerMiddleware);   // Log requests third

// Inject config and makeMeaning into context for all routes
app.use('*', async (c, next) => {
  c.set('config', config);
  c.set('eventBus', eventBus);
  c.set('makeMeaning', makeMeaning);
  await next();
});

// Mount route routers
app.route('/', rootRouter);
app.route('/', healthRouter);
app.route('/', authRouter);
app.route('/', statusRouter);
app.route('/', adminRouter);
const resourcesRouter = createResourcesRouter();
app.route('/', resourcesRouter);
const busRouter = createBusRouter(authMiddleware);
app.route('/', busRouter);

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
  // Serve the static OpenAPI spec — dist/openapi.json (prod) or specs/openapi.json (dev/test)
  const distPath = path.join(__dirname, 'openapi.json');
  const openApiPath = fs.existsSync(distPath) ? distPath : path.join(__dirname, '../../../specs/openapi.json');
  const openApiContent = fs.readFileSync(openApiPath, 'utf-8');
  const openApiSpec = JSON.parse(openApiContent);

  // Stamp the running build's version over the spec file's placeholder. The
  // committed spec carries a fixed `info.version` (OpenAPI requires the field)
  // that no release step rewrites, so serving it verbatim would report a
  // version this build is not. Same treatment as `servers` below: the file is
  // the contract, the response describes the instance answering.
  openApiSpec.info = { ...openApiSpec.info, version: __SEMIONT_VERSION__ };

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

// Only start server if not in test environment
if (config.env?.NODE_ENV !== 'test') {
  // Tier 2 observability — no-op when no OTEL_EXPORTER_OTLP_ENDPOINT set
  // (or `OTEL_SDK_DISABLED=true`). Init before serve() so any spans
  // created during request handling are captured.
  const { initObservabilityNode } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-backend' });

  // BEFORE serve(), and deliberately unguarded: this validates JWT_SECRET,
  // site.domain, and site.oauthAllowedDomains — without all three the process
  // cannot authenticate anyone, so it must not accept connections.
  //
  // It used to run inside the serve callback wrapped in a try/catch that only
  // logged, which meant a missing secret or site config produced a container
  // that listened, answered /api/health with 200 (that endpoint returns 200
  // unconditionally), reported healthy in `semiont status` — and failed every
  // sign-in. Failing here instead makes the misconfiguration undeployable.
  const { JWTService } = await import('./auth/jwt');
  JWTService.initialize(config);

  serve({
    fetch: app.fetch,
    port: port,
    hostname: '0.0.0.0'
  }, async (info) => {
    logger.info('Semiont Backend ready', {
      url: `http://localhost:${info.port}/api`,
      environment: config.env?.NODE_ENV ?? 'development'
    });

    // Startup posture log (SDK-AUTH-CORS Phase 6): make the open-CORS/bearer-only
    // stance visible at boot, so a future auth failure isn't misdiagnosed as the
    // CORS mystery that produced CORS-LOGIN-FIX.md.
    logger.info('Auth posture: bearer-only, open CORS', {
      cors: 'any origin (*)',
      credentials: 'disabled',
      auth: 'Authorization: Bearer; media tokens via ?token= for /api/resources/:id',
    });

    // The entity-type warm (getEntityTypes → initializeTagCollections seed)
    // moved into archivist-main with the rest of the record's startup
    // (EXTRACT-ARCHIVIST P3).
  });
}

export type AppType = typeof app;

// Export app for testing
export { app };