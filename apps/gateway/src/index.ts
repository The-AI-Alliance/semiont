import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { SemiontState } from '@semiont/core/node';
import { type EnvironmentConfig, EventBus, evaluateEnvPlaceholders, kbResource, withDeadline, errField } from '@semiont/core';
import {
  GATEWAY_HANDLER_CHANNELS,
  GATEWAY_HANDLER_EMITS,
  startMakeMeaningGateway,
  makeMeaningConfigFrom,
  requireKBName,
} from '@semiont/make-meaning';
import { JOB_QUEUE_EMITS } from '@semiont/jobs';
import { loadEnvironmentConfig } from '@semiont/core/node';
import type { Principal } from './identity/principal';


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

if (!config.services?.gateway) {
  throw new Error('services.gateway is required in environment config');
}

// Checked HERE, with the other startup requirements, rather than only in
// JWTService.initialize below: this runs before startMakeMeaningGateway builds
// the job queue and its subscriptions, so a missing secret costs a millisecond
// instead of a startup that has to be torn down again. Same rule either way —
// requireJwtSecret is the one copy.
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
// the wrong source for it either way: an environment section can override the
// project's, so it can report an identity the KB never declared. `[kb]` sits
// beside `[defaults]`, out of that reach, and the launcher stages NO domain
// when the KB declares none — so an undeclared identity still arrives here as
// absent, and still refuses below.
//
// All three resolved values escape the block so JWTService.initialize and the
// trusted issuer can be handed them, rather than re-deriving them from a config
// shape this process no longer fully has.
let effectiveDomain: string;
let committedKbDomain: string;

{
  const committedDomain = config.kb?.domain;

  // Decision 8 — a knowledge base declares its identity or does not run.
  // `semiont start` already refuses this; a gateway launched another way
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
  // ABSENCE IS NOT DIVERGENCE. An environment `[site] domain` is an override,
  // and most KBs declare none — so with no `[site]` at all the agents mint
  // under the KB's own committed identity, which is what they did while this
  // process still read the committed file directly. Treating absent as a
  // divergence produced `agents will be minted under "undefined"` and then a
  // refusal in JWTService, which is how a KB that was perfectly well-formed
  // could not start.
  effectiveDomain = config.site?.domain ?? committedDomain;
  committedKbDomain = committedDomain;

  if (config.site?.domain !== undefined && config.site.domain !== committedDomain) {
    // eslint-disable-next-line no-console
    console.warn(
      `[identity] KB is "${committedDomain}" (committed .semiont/config) but agents will be minted under ` +
        `"${effectiveDomain}" (environment config). The KB's own did is unaffected; only agent identities move. ` +
        'If unintended, remove the `site` section for this environment from the KB\'s ' +
        '`.semiont/semiontconfig/<name>.toml` — that file is the source of truth; inside the container it is ' +
        'only mounted read-only at ~/.semiontconfig, so editing it there does not persist.',
    );
  }

}

// The issuer the gateway trusts for human tokens (EXTERNAL-IDENTITY): keys are
// discovered on first use, so a configured issuer that is unreachable surfaces
// at the first human request, not here. No section, no trusted issuer — only
// gateway-signed tokens authenticate.
//
// The AUDIENCE is not configured. It is this knowledge base's own resource
// identifier, derived from the committed did:web domain resolved above, which
// is why this runs after that block rather than before it. One declared fact
// decides both what the KB calls itself and what it requires in `aud`, so the
// two cannot be configured into disagreement — and a disagreement here refuses
// every token while looking like a working deployment.
const { configureTrustedIssuer } = await import('./identity/trusted-issuer');
// `[identity]` is mandatory (user, 2026-09-21): the loaders refuse a config
// without it, so this is an assertion that they did, not a fallback.
const identity: NonNullable<EnvironmentConfig['services']['identity']> = (() => {
  const configured = config.services.identity;
  if (!configured) {
    throw new Error('services.identity is required — every knowledge base trusts an issuer');
  }
  return configured;
})();
configureTrustedIssuer(identity, kbResource(committedKbDomain));

// What it takes to reach the record, with the rest of the startup
// requirements — both used to surface on the first Archivist read instead.
const { requireArchivistAccess } = await import('./boot-requirements');
const archivistAccess = requireArchivistAccess(config);

const gatewayService = config.services.gateway;

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
import { wellKnownRouter } from './routes/well-known';
import { authRouter } from './routes/auth';
import { statusRouter } from './routes/status';
import { createResourcesRouter } from './routes/resources/index';
import { createBusRouter } from './routes/bus';
import { createNatsSignalPlane } from './signal/nats';
import { SIGNAL_FLUSH_TIMEOUT_MS } from './signal/options';
import { bridgeGatewayHandlers, compositionFor } from './signal';
import type { ServiceAccountCredential } from '@semiont/core';
import { authMiddleware } from './middleware/auth';

// Import for static OpenAPI spec
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import security headers middleware
import { securityHeaders } from './middleware/security-headers';
// Import logging middleware
import { requestIdMiddleware } from './middleware/request-id';
import { requestLoggerMiddleware } from './middleware/request-logger';
import { errorLoggerMiddleware } from './middleware/error-logger';

type Variables = {
  principal: Principal;
  config: EnvironmentConfig;
  eventBus: EventBus;
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

/**
 * This process's own account at the knowledge base's issuer.
 *
 * Resolved HERE because this is the gateway's boundary, which is where every
 * other service resolves it — six `*-main.ts` entry points read the same pair.
 * It used to be read inside `archivistAddress`, so the gateway never named the
 * credential it depends on and nothing could supply a different one.
 *
 * Eager: requireArchivistAccess asserted both halves above, so nothing here
 * could legitimately be absent and none of it needs discovering on a request.
 */
const archivistCredentialValue: ServiceAccountCredential = {
  issuer: identity.issuer,
  clientId: archivistAccess.clientId,
  clientSecret: archivistAccess.clientSecret,
};
function archivistCredential(): ServiceAccountCredential {
  return archivistCredentialValue;
}

// Inject config, the event bus and HOW TO GET this process's credential into
// context for all routes. A resolver rather than a value, so a gateway that
// never dials the Archivist never has to have one.
app.use('*', async (c, next) => {
  c.set('config', config);
  c.set('archivistCredential', archivistCredential);
  c.set('eventBus', eventBus);
  await next();
});

// Mount route routers
app.route('/', rootRouter);
app.route('/', healthRouter);
app.route('/', wellKnownRouter);
app.route('/', authRouter);
app.route('/', statusRouter);
const resourcesRouter = createResourcesRouter();
app.route('/', resourcesRouter);
// ── Signal Plane selection (SIGNAL-PLANE P2, D6) ─────────────────────────
// services.signal comes from [environments.<env>.signal]; absent means the
// in-process driver, bit for bit (D7 — it never retires). The loader already
// refused typed-but-incomplete, so a 'nats' selection here always has
// servers. Under NATS the ingest receipt carries no observer count, so the
// unanswerable-request fast-fail is absent and callers fall back to the
// busRequest timeout — the recorded P2 consequence, restated at the
// selection site so the operator reading this file learns it here.
const signalConfig = config.services.signal;
const signalPlane =
  signalConfig?.type === 'nats'
    ? await createNatsSignalPlane({
        servers: evaluateEnvPlaceholders(signalConfig.servers ?? ''),
        // Credentials are optional: absent means an unauthenticated broker.
        ...(signalConfig.user ? { user: evaluateEnvPlaceholders(signalConfig.user) } : {}),
        ...(signalConfig.password ? { pass: evaluateEnvPlaceholders(signalConfig.password) } : {}),
      })
    : undefined;
logger.info('Signal Plane driver selected', { driver: signalConfig?.type ?? 'in-process' });

// The composition (P3): plane + ledger, seeded HERE with the configured
// driver so the ledger's standing tap exists from boot; routes reach the
// same composition through the bus.
compositionFor(eventBus, signalPlane);

// The handler bridge (P3, the H2 fix) — installed EXACTLY when the plane is
// remote. Under the in-process driver the plane IS this bus: handlers hear
// ingests directly and their emissions are already plane-visible, so a
// bridge would double-deliver every frame. This conditional is the one
// place composition acknowledges which driver won, beside the selection
// itself.
if (signalPlane) {
  // Outbound is the UNION of gateway-resident emitters: the handlers AND the
  // queue drivers (job:queued announcements are the queue's, not a handler's).
  bridgeGatewayHandlers(signalPlane, eventBus, GATEWAY_HANDLER_CHANNELS, [
    ...GATEWAY_HANDLER_EMITS,
    ...JOB_QUEUE_EMITS,
  ]);
  // THE READINESS GATE (SIGNAL-PLANE-FLUSH D4). Subscribing is synchronous;
  // REGISTERING that interest with the broker is not, and core NATS is
  // at-most-once, so a request arriving before registration lands is
  // dispatched to a queue group with no member: `ingest` reports zero
  // observers and the gateway synthesizes `peer-unavailable`, blaming an
  // absent service for its own boot race. Awaiting here is what makes the
  // load balancer's health check mean what it has always implied.
  //
  // One round trip, once, after every subscription is composed — never per
  // subscribe and never per frame (D3). Under the in-process driver this is an
  // already-resolved promise and boot is byte-identical.
  //
  // BOUNDED, because the round trip is to a broker that may be gone: the NATS
  // client reconnects forever (`maxReconnectAttempts: -1`), so an unbounded
  // flush against a dead broker never settles and boot stops here — before
  // `serve()`, so the port never opens and the failure has no error to show.
  // Expiring throws, which is the right answer: the gate exists to refuse
  // service until routing works.
  await withDeadline('Signal Plane readiness flush', SIGNAL_FLUSH_TIMEOUT_MS,
    () => signalPlane.flush(),
    'The broker is unreachable; the gateway will not serve until it answers.');
  logger.info('Signal Plane handler bridge active', {
    consumed: GATEWAY_HANDLER_CHANNELS.length,
    emitted: GATEWAY_HANDLER_EMITS.length,
  });
}

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
  const port = gatewayService.port || 4000;
  const apiUrl = gatewayService.publicURL || `http://localhost:${port}`;
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
const port = gatewayService.port || 4000;

// Only start server if not in test environment
if (config.env?.NODE_ENV !== 'test') {
  // Tier 2 observability — no-op when no OTEL_EXPORTER_OTLP_ENDPOINT set
  // (or `OTEL_SDK_DISABLED=true`). Init before serve() so any spans
  // created during request handling are captured.
  const { initObservabilityNode } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-gateway' });

  // `semiont.process.restarts` (GATEWAY-SUPERVISION F3). The supervisor is
  // POSIX shell and cannot emit OTel, but it keeps a durable event log on the
  // state mount and writes one `starting gateway` line per life — so the child
  // reports the count on its behalf. The supervisor exports the log path and
  // the service name; nothing here restates either.
  //
  // F2 (this file) and F3 (the metric) are not redundant: metrics leave over
  // OTLP and a process that dies before flushing never gets the last word out,
  // while the file survives even a torn-down container. They fail differently.
  const { registerSupervisorRestartCount } = await import('@semiont/observability/node');
  registerSupervisorRestartCount();

  // BEFORE serve(), and deliberately unguarded: this validates JWT_SECRET and
  // site.domain — without both the process cannot mint or attribute a token,
  // so it must not accept connections.
  //
  // It used to run inside the serve callback wrapped in a try/catch that only
  // logged, which meant a missing secret or site config produced a container
  // that listened, answered /api/health with 200 (that endpoint returns 200
  // unconditionally), reported healthy in `semiont status` — and failed every
  // sign-in. Failing here instead makes the misconfiguration undeployable.
  const { JWTService } = await import('./auth/jwt');
  // The RESOLVED domain, not `config`: it may come from the staged `[kb]`
  // identity rather than a `[site]` section, and the resolution above is its one
  // home. Passing the raw config made JWTService reach for `config.site`, which
  // a KB with no environment `[site]` does not have.
  JWTService.initialize({ site: { domain: effectiveDomain } });

  const server = serve({
    fetch: app.fetch,
    port: port,
    hostname: '0.0.0.0'
  }, async (info) => {
    logger.info('Semiont Gateway ready', {
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

  // Graceful shutdown, matching every sidecar (archivist/librarian/smelter/
  // weaver/worker `-main`). The gateway was the ONLY Semiont service without
  // one: on `semiont stop` the runtime's SIGTERM fell through to the default
  // handler, so the process died mid-request with its Postgres pool still
  // open and the job-status subscription still live.
  //
  // Registered inside the non-test guard with `serve()`: a test importing this
  // module must not install process-wide signal handlers.
  //
  // Order is stop-taking-work first, then release: close the listener so no new
  // request is accepted, unsubscribe the job-status pump, tear down the bus,
  // and disconnect the one datastore the gateway owns.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    // A second signal during teardown would double-close the listener and race
    // the disconnect. The sidecars do not guard this; here it is two lines.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    void (async () => {
      try {
        server.close();
        await makeMeaning.stop();
        // Drain before the connection dies with the process
        // (SIGNAL-PLANE-FLUSH D5). `nc.publish` returns having written into a
        // client-side buffer; on a scale-down or redeploy, frames written
        // moments earlier — replies whose requesters are still waiting — go
        // with the process. They get a timeout while the operator sees a clean
        // shutdown, which is the silent lossy mode L4 forbids. One round trip
        // at the end of teardown, after the actors that might still publish
        // have stopped.
        //
        // Explicit rather than folded into `dispose()`: this is the only
        // production disposal path and it is already async, whereas making
        // `dispose()` return a promise would touch every composition root and
        // every test teardown for a single call site.
        // Bounded, and a timeout is NOT fatal here: the drain is best effort
        // (the interface is explicit that flush confirms nothing), and a
        // gateway restarted DURING a broker outage would otherwise hang here
        // until the runtime SIGKILLs it — skipping the teardown below. Losing
        // the drain is the smaller harm; losing it silently is not, so it logs.
        if (signalPlane) {
          await withDeadline('Signal Plane drain', SIGNAL_FLUSH_TIMEOUT_MS, () => signalPlane!.flush())
            .catch((error: unknown) => logger.warn('Signal Plane drain timed out; in-flight frames may be lost', { error: errField(error) }));
        }
        eventBus.destroy();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        // Exit non-zero: a teardown that failed halfway is not a clean stop,
        // and the runtime should see that rather than a success code.
        logger.error('Shutdown failed', { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export type AppType = typeof app;

// Export app for testing
export { app };