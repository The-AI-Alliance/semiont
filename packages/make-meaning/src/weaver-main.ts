/**
 * Weaver Main — standalone entry point (WEAVER-ISOLATION P4)
 *
 * Thin wiring for the `Weaver` pipeline: loads configuration from
 * ~/.semiontconfig (TOML) via the canonical `createTomlConfigLoader`,
 * authenticates with the KS via shared secret, connects the graph
 * database, hands the WeaverActorStateUnit's streams to the Weaver, and
 * runs a startup catch-up. All event processing lives in `./weaver`.
 *
 * The weaver is a pure network peer: events and rebuild commands arrive
 * over SSE, history reads (`browse:*`) and `weave:applied` signals ride
 * the same bus, and its single privileged attachment beyond the bus is
 * the graph database. The graph projection is part of the graph stack,
 * not of the backend process (D4) — this entry point IS that stack
 * membership.
 *
 * Environment variables:
 *   SEMIONT_WORKER_SECRET — shared secret for JWT auth with the KS
 */

import { BehaviorSubject } from 'rxjs';
import { createWeaverActorStateUnit, type WeaverActorStateUnit } from './weaver-actor-state-unit';
import { Weaver, type WeaverTiming } from './weaver';
import { FileWeaverCheckpoint } from './weaver-checkpoint';
import { HttpTransport } from '@semiont/http-transport';
import { baseUrl as makeBaseUrl, accessToken as makeAccessToken, createTomlConfigLoader } from '@semiont/core';
import type { AccessToken } from '@semiont/core';
import { getGraphDatabase } from '@semiont/graph';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ───────────────────────────────────────────────────────────

const configPath = join(homedir(), '.semiontconfig');
const tomlReader = {
  readIfExists: (p: string): string | null => existsSync(p) ? readFileSync(p, 'utf-8') : null,
};
const envConfig = createTomlConfigLoader(
  tomlReader,
  configPath,
  process.env,
)(null, 'local');

const backendPublicURL = envConfig.services?.backend?.publicURL;
if (!backendPublicURL) {
  throw new Error('services.backend.publicURL is required in ~/.semiontconfig');
}
const baseUrl: string = backendPublicURL;

const maybeGraphConfig = envConfig.services?.graph;
if (!maybeGraphConfig?.type) {
  throw new Error('services.graph.type is required in ~/.semiontconfig');
}
if (maybeGraphConfig.type === 'memory') {
  // The in-memory graph is a hermetic TEST sink — it lives in a single
  // process's heap and cannot be shared with the backend's readers.
  throw new Error("services.graph.type 'memory' is a test-only sink; the weaver requires a server-backed graph");
}
// Re-bind after the guards: module-level narrowing does not carry into main().
const graphConfig = maybeGraphConfig;

const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';

const healthPort = 9092;

// The checkpoint is an optimization, never a correctness input — losing it
// degrades the next catch-up to a full replay. XDG state dir, matching the
// platform convention SemiontProject already follows.
const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
const checkpointPath = join(stateHome, 'semiont', 'weaver-checkpoint.json');

import { createProcessLogger } from '@semiont/observability/process-logger';
const logger = createProcessLogger('weaver');

// ── Auth ─────────────────────────────────────────────────────────────

async function authenticate(): Promise<string> {
  if (!workerSecret) {
    logger.warn('No SEMIONT_WORKER_SECRET set — using empty token');
    return '';
  }

  // The weaver is a Software peer (D2: the Smelter's exchange). It has no
  // inference (provider, model), so it authenticates under the stable
  // identity (semiont, weaver) — DID did:web:<host>:agents:semiont:weaver —
  // and the bus stamps that onto every signal it emits.
  const response = await fetch(`${baseUrl}/api/tokens/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: workerSecret,
      provider: 'semiont',
      model: 'weaver',
    }),
  });

  if (!response.ok) {
    throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
  }

  const { token } = await response.json() as { token: string; did: string };
  return token;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-weaver' });

  logger.info('Authenticating', { baseUrl });
  const tokenSubject = new BehaviorSubject<AccessToken | null>(makeAccessToken(await authenticate()));
  logger.info('Authenticated');

  // Agent tokens expire (24h — POST /api/tokens/agent). Two recovery paths
  // keep a long-lived worker authenticated: `tokenRefresher` re-authenticates
  // and retries once when any HTTP request 401s, and a proactive re-auth at
  // half the TTL covers the listen-only case — SSE reconnects read `token$`
  // fresh, so pushing here is what keeps the event feed alive.
  const refreshToken = async (): Promise<string | null> => {
    const token = await authenticate();
    tokenSubject.next(makeAccessToken(token));
    return token;
  };
  const reauthTimer = setInterval(() => {
    refreshToken().catch((error) => {
      logger.error('Proactive re-authentication failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 12 * 60 * 60 * 1000);

  const graphDb = await getGraphDatabase(graphConfig);
  logger.info('Graph database ready', { type: graphConfig.type });

  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: tokenSubject,
    tokenRefresher: refreshToken,
  });
  const actorStateUnit: WeaverActorStateUnit = createWeaverActorStateUnit({
    bus: httpTransport.actor,
  });

  // Production timings (WEAVER-AXIOMS R0 — the axiom harness runs ~1 ms).
  const timing: WeaverTiming = {
    burstWindowMs: 50,
    maxBatchSize: 500,
    idleTimeoutMs: 200,
    drainTimeoutMs: 30_000,
    drainPollMs: 25,
    drainStallPolls: 40,
    checkpointFlushMs: 5_000,
  };

  const weaver = new Weaver(
    graphDb,
    actorStateUnit.events$,
    actorStateUnit.rebuilds$,
    httpTransport,
    new FileWeaverCheckpoint(checkpointPath),
    timing,
    logger,
  );
  await weaver.initialize();

  actorStateUnit.start();
  logger.info('Subscribed to graph-relevant events and rebuild commands');

  let catchUpState: Record<string, unknown> = { phase: 'pending' };
  let reconcileState: Record<string, unknown> = { phase: 'pending' };

  const health = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        ...weaver.getHealthMetrics(),
        catchUp: catchUpState,
        reconcile: reconcileState,
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  health.listen(healthPort, () => {
    logger.info('Health endpoint ready', { port: healthPort });
  });

  const shutdown = () => {
    logger.info('Shutting down');
    clearInterval(reauthTimer);
    actorStateUnit.dispose();
    httpTransport.dispose();
    void weaver.stop().then(() => {
      health.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Catch-up pass: the live subscription is attached, so anything that
  // changed while this weaver was down is brought back in sync here —
  // checkpointed replay, full replay if the checkpoint is gone. Fatal on
  // failure: a weaver that cannot catch up is projecting a graph of
  // unknown freshness. (A restart re-runs it — catch-up is idempotent.)
  catchUpState = { phase: 'running' };
  try {
    const summary = await weaver.catchUp();
    catchUpState = { phase: 'done', summary };
  } catch (error) {
    catchUpState = { phase: 'failed', error: error instanceof Error ? error.message : String(error) };
    throw error;
  }

  // Reconcile pass (#845): the state-diff backstop for divergence the
  // accounting cannot witness — out-of-band mutations, wiped/rolled-back
  // graph volumes, historical damage. Fatal on a thrown reconcile (bus
  // unreachable); heal failures are reported in the summary, not fatal.
  reconcileState = { phase: 'running' };
  try {
    const summary = await weaver.reconcile();
    reconcileState = { phase: 'done', summary };
  } catch (error) {
    reconcileState = { phase: 'failed', error: error instanceof Error ? error.message : String(error) };
    throw error;
  }
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
