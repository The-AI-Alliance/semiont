import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { EventBus, kbResource, withDeadline, errField, isObject } from '@semiont/core';
import type { Principal } from './identity/principal';
import { CONFIG_PATH, fromEnvironment, readGatewayConfig, type GatewayConfig } from './config';

// Everything the gateway reads at boot is one document the launcher writes
// resolved (GatewayConfig in specs/; the user's ruling on GATEWAY-SIMPLIFY S1,
// 2026-09-27: "Resolved JSON doc"). It is validated here and nothing in it is
// defaulted: a document that does not validate stops the process before it
// serves. The KB's identity — its committed `[site] domain` — is in it, which
// is how a gateway that mounts no KB tree knows what it is: the audience it
// accepts tokens for, the authority its people and agents are named under,
// and the issuer of the tokens it signs (KB-IDENTITY-VS-ADDRESS decision 8).
const config: GatewayConfig = readGatewayConfig(CONFIG_PATH);
const kbDomain = config.kb.domain;

// Checked HERE, with the other startup requirements, rather than only in
// JWTService.initialize below: a missing secret should cost a millisecond at
// boot, not a startup that has opened connections and has to be torn down
// again. Same rule either way — requireJwtSecret is the one copy.
const { requireJwtSecret } = await import('./auth/jwt');
requireJwtSecret();

// The issuer the gateway trusts for human tokens (EXTERNAL-IDENTITY): keys are
// discovered on first use, so a configured issuer that is unreachable surfaces
// at the first human request, not here.
//
// The AUDIENCE is not configured. It is this knowledge base's own resource
// identifier, derived from its domain. One declared fact decides what the KB
// calls itself, what it requires in `aud`, and the authority its people and
// agents are named under — a person and the software working for them are
// peers beneath one did:web (VERIFIED-PROVENANCE P5).
const { configureTrustedIssuer } = await import('./identity/trusted-issuer');
configureTrustedIssuer(config.identity, { audience: kbResource(kbDomain), domain: kbDomain });

// The gateway's own account at the issuer, which it reaches the Archivist with.
const { requireServiceAccount } = await import('./boot-requirements');
const serviceAccount = requireServiceAccount();

// Import logging utilities
import { initializeLogger, getLogger } from './logger';

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

// Create global EventBus for real-time events. The gateway hosts no
// make-meaning slice of its own anymore (EXTRACT-JOBS P2/P3): the job queue and
// its nine `job:*` handlers moved to the dispatcher. This bus exists to feed
// the signal-plane routes (/bus/emit, /bus/subscribe) that route frames —
// `job:*` among them — across the plane to the services that answer them.
const eventBus = new EventBus();

// Import route definitions
import { healthRouter } from './routes/health';
import { wellKnownRouter } from './routes/well-known';
import { authRouter } from './routes/auth';
import { statusRouter } from './routes/status';
import { createResourcesRouter } from './routes/resources/index';
import { createBusRouter } from './routes/bus';
import { createNatsSignalPlane } from './signal/nats';
import { SIGNAL_FLUSH_TIMEOUT_MS } from './signal/options';
import { compositionFor, SignalPlaneUnavailable } from './signal';
import { authMiddleware } from './middleware/auth';
import type { ArchivistAccess } from './lib/archivist';
import { routeMismatches } from './spec-routes';

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

type Variables = {
  principal: Principal;
  config: GatewayConfig;
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

// Logging: the request id first, so every later line carries it.
app.use('*', requestIdMiddleware);
app.use('*', requestLoggerMiddleware);

// Every error is an ErrorResponse, whatever threw it (TRANSPORT-HTTP.md
// § Every response). An HTTPException carries its status and message; anything
// else is a 500 whose cause goes to the log and never to the caller.
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof SignalPlaneUnavailable) {
    return c.json({ error: error.message }, 503);
  }
  c.get('logger').error('Unhandled error during request processing', {
    type: 'unhandled_error',
    method: c.req.method,
    path: c.req.path,
    error: error.message,
    stack: error.stack,
    name: error.name,
  });
  return c.json({ error: 'Internal server error' }, 500);
});
app.notFound((c) => c.json({ error: 'Not found' }, 404));

/**
 * Where the Archivist is and this process's own account to reach it with,
 * resolved once: the document and requireServiceAccount asserted every part
 * above, so nothing here needs discovering on a request.
 */
const archivist: ArchivistAccess = {
  address: { services: { archivist: config.archivist } },
  credential: { issuer: config.identity.issuer, clientId: serviceAccount.clientId, clientSecret: serviceAccount.clientSecret },
};

app.use('*', async (c, next) => {
  c.set('config', config);
  c.set('archivist', archivist);
  c.set('eventBus', eventBus);
  await next();
});

// Mount route routers
app.route('/', healthRouter);
app.route('/', wellKnownRouter);
app.route('/', authRouter);
app.route('/', statusRouter);
const resourcesRouter = createResourcesRouter();
app.route('/', resourcesRouter);
// ── Signal Plane selection (SIGNAL-PLANE P2, D6) ─────────────────────────
// `in-process` is the driver that never retires (D7); `nats` is the fabric
// replicas share, and the document is only valid with its servers. Under
// NATS the ingest receipt carries no observer count, so the
// unanswerable-request fast-fail is absent and callers fall back to the
// busRequest timeout — the recorded P2 consequence, restated at the
// selection site so the operator reading this file learns it here.
const signalConfig = config.signal;
const signalPlane =
  signalConfig.type === 'nats'
    ? await createNatsSignalPlane({
        servers: signalConfig.servers,
        // Credentials are named, never carried: the document holds the names
        // of the environment variables, and absent means an unauthenticated broker.
        ...(signalConfig.userEnv ? { user: fromEnvironment('/signal/userEnv', signalConfig.userEnv) } : {}),
        ...(signalConfig.passwordEnv ? { pass: fromEnvironment('/signal/passwordEnv', signalConfig.passwordEnv) } : {}),
      })
    : undefined;
logger.info('Signal Plane driver selected', { driver: signalConfig.type });

// The composition (P3): plane + ledger, seeded HERE with the configured
// driver so the ledger's standing tap exists from boot; routes reach the
// same composition through the bus.
const composition = compositionFor(eventBus, signalPlane);

// THE READINESS GATE (SIGNAL-PLANE-FLUSH D4) — for the remote plane. The
// gateway hosts no `job:*` handler, so there is no handler island to
// reconnect; what it registers is its OWN plane interest: `compositionFor`
// above opened the ledger's standing tap (reply retention), and every
// /bus/subscribe client opens more. Subscribing is
// synchronous; REGISTERING that interest with the broker is not, and core NATS
// is at-most-once, so a frame arriving before registration lands is dropped
// rather than delayed. Awaiting one round trip here — once, after the
// composition's subscriptions are set up, never per subscribe and never per
// frame (D3) — is what makes the load balancer's health check mean the gateway
// can actually route.
//
// Under the in-process driver `signalPlane` is undefined and this is skipped:
// the plane IS the bus and there is nothing to register.
//
// BOUNDED, because the round trip is to a broker that may be gone: the NATS
// client reconnects forever (`maxReconnectAttempts: -1`), so an unbounded
// flush against a dead broker never settles and boot stops here — before
// `serve()`, so the port never opens and the failure has no error to show.
// Expiring throws, which is the right answer: the gate exists to refuse
// service until routing works.
if (signalPlane) {
  await withDeadline('Signal Plane readiness flush', SIGNAL_FLUSH_TIMEOUT_MS,
    () => signalPlane.flush(),
    'The broker is unreachable; the gateway will not serve until it answers.');
  logger.info('Signal Plane ready', { driver: signalConfig.type });
}

// The ledger's claims table, open and projected before the port opens: a
// replica that served first would claim into a table it could not read, and
// under NATS the table is a JetStream KV bucket, so a broker without
// JetStream refuses here — loudly, at boot — rather than at the first
// request. Bounded for the same reason as the flush above.
await withDeadline('Ledger claims table', SIGNAL_FLUSH_TIMEOUT_MS,
  () => composition.ready,
  'The broker did not open the claims table; it must run with JetStream enabled.');

const busRouter = createBusRouter(authMiddleware);
app.route('/', busRouter);

// The OpenAPI document: the contract this gateway serves. The build copies the
// bundled spec beside the entry point.
const openApiDocument: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf-8'));
const openApiPaths = isObject(openApiDocument) ? openApiDocument['paths'] : undefined;
const openApiInfo = isObject(openApiDocument) ? openApiDocument['info'] : undefined;
if (!isObject(openApiDocument) || !isObject(openApiPaths) || !isObject(openApiInfo)) {
  throw new Error(`${path.join(__dirname, 'openapi.json')} is not an OpenAPI document with info and paths`);
}

// Published as it runs, with the running build's version stamped over the
// spec file's placeholder. The committed spec carries a fixed `info.version`
// (OpenAPI requires the field) that no release step rewrites, so serving it
// verbatim would report a version this build is not. Same treatment as
// `servers`: the file is the contract, the response describes the instance
// answering.
app.get('/api/openapi.json', (c) =>
  c.json({
    ...openApiDocument,
    info: { ...openApiInfo, version: __SEMIONT_VERSION__ },
    servers: [{ url: config.publicUrl, description: 'API Server' }],
  }),
);

// Start server
const port = config.port;

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

// `semiont.bus.correlation.size` — the claims this replica's ledger holds,
// against the cap that bounds them.
//
// Registered HERE rather than inside `compositionFor`, which the module
// scope above already called: an observable gauge binds the meter that
// exists when it is created, and before this init that is the no-op one.
// Composing at import time is correct for the ledger's tap and wrong for
// its metric, so the two happen where each of them works.
const { registerCorrelationRegistryProvider } = await import('@semiont/observability');
registerCorrelationRegistryProvider(() => compositionFor(eventBus).occupancy());

// BEFORE serve(), and deliberately unguarded: this validates JWT_SECRET —
// without it the process cannot mint or attribute a token, so it must not
// accept connections.
//
// Inside the serve callback it would be too late: /api/health answers 200
// unconditionally, so a missing secret would yield a container that listens,
// reports healthy in `semiont status`, and fails every sign-in. Failing here
// makes the misconfiguration undeployable.
const { JWTService } = await import('./auth/jwt');
JWTService.initialize(kbDomain);

// The route table is final here: the gateway serves exactly what its spec
// declares, or nothing (spec-routes.ts).
const mismatches = routeMismatches(app.routes, openApiPaths);
if (mismatches.length > 0) {
  throw new Error(
    `The gateway's routes are not its spec's operations:\n${mismatches.map((m) => `  - ${m}`).join('\n')}\n` +
      'The spec is the route table: declare a route in specs/src (and rebundle) before registering it, and serve every operation it declares.',
  );
}

const server = serve({
  fetch: app.fetch,
  port: port,
  hostname: '0.0.0.0'
}, async (info) => {
  logger.info('Semiont Gateway ready', {
    url: `http://localhost:${info.port}/api`,
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
// handler, so the process died mid-request.
//
// Order is stop-taking-work first, then release: close the listener so no new
// request is accepted, drain the signal plane so in-flight replies are not
// lost with the connection, then tear down the bus. The job queue and its
// teardown left with the dispatcher (EXTRACT-JOBS P2/P3); the gateway owns no
// datastore to disconnect.
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
