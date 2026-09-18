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
 * not of the gateway process (D4) — this entry point IS that stack
 * membership.
 *
 * Environment variables:
 *   SEMIONT_WORKER_SECRET — shared secret for JWT auth with the KS
 */

import { WEAVER_MANIFEST, createWeaverActorStateUnit, type WeaverActorStateUnit } from './weaver-actor-state-unit';
import { Weaver, type WeaverTiming } from './weaver';
import { FileWeaverCheckpoint } from './weaver-checkpoint';
import { HttpTransport } from '@semiont/http-transport';
import { baseUrl as makeBaseUrl, createTomlConfigLoader } from '@semiont/core';
import { runBootPass, type BootPassState } from './boot-pass';
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
// Environment resolved by the loader from `[defaults] environment`
// (no project root here — global ~/.semiontconfig only). Was hardcoded 'local',
// which read the wrong section for any non-local KB the container stages.
const envConfig = createTomlConfigLoader(
  tomlReader,
  configPath,
  process.env,
)(null);

const gatewayPublicURL = envConfig.services?.gateway?.publicURL;
if (!gatewayPublicURL) {
  throw new Error('services.gateway.publicURL is required in ~/.semiontconfig');
}
const baseUrl: string = gatewayPublicURL;

const maybeGraphConfig = envConfig.services?.graph;
if (!maybeGraphConfig?.type) {
  throw new Error('services.graph.type is required in ~/.semiontconfig');
}
if (maybeGraphConfig.type === 'memory') {
  // The in-memory graph is a hermetic TEST sink — it lives in a single
  // process's heap and cannot be shared with the gateway's readers.
  throw new Error("services.graph.type 'memory' is a test-only sink; the weaver requires a server-backed graph");
}
// Re-bind after the guards: module-level narrowing does not carry into main().
const graphConfig = maybeGraphConfig;

const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';

const healthPort = 24102;

// The checkpoint is an optimization, never a correctness input — losing it
// degrades the next catch-up to a full replay. XDG state dir, matching the
// platform convention SemiontProject already follows.
const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
const checkpointPath = join(stateHome, 'semiont', 'weaver-checkpoint.json');

import { createProcessLogger } from '@semiont/observability/process-logger';
import { startAgentSession } from './agent-session';
const logger = createProcessLogger('weaver');

// ── Auth ─────────────────────────────────────────────────────────────

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode, registerSupervisorRestartCount } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-weaver' });
  // Supervised, but with no writable /semiont-state: `supervise.sh` keeps its
  // event log in /tmp and exports the resolved path. That is enough for the
  // LIVE count — the container does not exit when the child restarts — and
  // only surviving container teardown would need a mount (F2, declined).
  registerSupervisorRestartCount();

  // The weaver is a Software peer (D2: the Smelter's exchange). It has no
  // inference (provider, model), so it authenticates under the stable
  // identity (semiont, weaver) — DID did:web:<host>:agents:semiont:weaver —
  // and the bus stamps that onto every signal it emits.
  //
  // The token's lifetime and the refresh cadence derived from it are the
  // gateway's to decide; see `startAgentSession`.
  const session = await startAgentSession({
    baseUrl,
    workerSecret,
    provider: 'semiont',
    model: 'weaver',
    logger,
  });

  const graphDb = await getGraphDatabase(graphConfig);
  logger.info('Graph database ready', { type: graphConfig.type });

  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: session.token$,
    tokenRefresher: session.refresh,
    // The whole manifest at construction — reply channels, the domain-event
    // fold and the command channels — not the reply set plus a later
    // widening. See WEAVER_MANIFEST.
    channels: WEAVER_MANIFEST,
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

  let catchUpState: BootPassState = { phase: 'pending' };
  let reconcileState: BootPassState = { phase: 'pending' };

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
    session.stop();
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
  // checkpointed replay, full replay if the checkpoint is gone.
  //
  // NOT fatal since SIDECAR-BOOT-RESILIENCE P3. It used to be, on the argument
  // that "a weaver that cannot catch up is projecting a graph of unknown
  // freshness" — true, but exiting does not make the graph fresher, and the rule
  // only ever guarded this ~30 s window: a subscription that drops silently an
  // hour from now leaves exactly the same stale graph. What it did guarantee was
  // that one 429 removed the weaver entirely (2026-09-07). The failed phase is
  // recorded and logged; the live subscription keeps running.
  await runBootPass('catch-up', () => weaver.catchUp(), logger, (s) => { catchUpState = s; });

  // Reconcile pass (#845): the state-diff backstop for divergence the
  // accounting cannot witness — out-of-band mutations, wiped/rolled-back
  // graph volumes, historical damage. Also non-fatal (P3); heal failures were
  // already reported in the summary rather than thrown.
  await runBootPass('reconcile', () => weaver.reconcile(), logger, (s) => { reconcileState = s; });
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
