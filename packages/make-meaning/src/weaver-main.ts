/**
 * Weaver Main — standalone entry point
 *
 * Thin wiring for the `Weaver` pipeline: loads configuration from
 * ~/.semiontconfig (TOML) via the canonical `createTomlConfigLoader`,
 * holds an agent token for its service account (`./agent-session`), connects the graph
 * database, hands the fan-in's streams to the Weaver, and
 * runs a startup catch-up. All event processing lives in `./weaver`.
 *
 * The weaver is a pure network peer: events and rebuild commands arrive
 * over SSE, history reads (`browse:*`) and `weave:applied` signals ride
 * the same bus, and its single privileged attachment beyond the bus is
 * the graph database. The graph projection is part of the graph stack, not
 * of the service that keeps the record — this entry point IS that stack
 * membership.
 *
 * Environment variables:
 *   SEMIONT_OIDC_CLIENT_ID     — this process's own account at the KB's
 *   SEMIONT_OIDC_CLIENT_SECRET   issuer; buys the agent token it shows the gateway
 */

import { WEAVER_MANIFEST, weaverFanIn } from './weaver-fan-in';
import { Weaver, type WeaverTiming } from './weaver';
import { FileWeaverCheckpoint } from './weaver-checkpoint';
import { HttpTransport } from '@semiont/http-transport';
import { baseUrl as makeBaseUrl, createTomlConfigLoader, withDeadline } from '@semiont/core';
import { runBootPass, type BootPassState } from './boot-pass';
import { STARTUP_CONNECT_TIMEOUT_MS, RESTART_HINT } from './service';
import { getGraphDatabase } from '@semiont/graph';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

// ── Config ───────────────────────────────────────────────────────────

const configPath = join(homedir(), '.semiontconfig');
const tomlReader = {
  readIfExists: (p: string): string | null => existsSync(p) ? readFileSync(p, 'utf-8') : null,
};
// Environment resolved by the loader from `[defaults] environment`
// (no project root here — global ~/.semiontconfig only).
const envConfig = createTomlConfigLoader(
  tomlReader,
  configPath,
  process.env,
  'weaver',
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
  // process's heap and cannot be shared with the graph's readers (the
  // Archivist and the Librarian).
  throw new Error("services.graph.type 'memory' is a test-only sink; the weaver requires a server-backed graph");
}
// Re-bind after the guards: module-level narrowing does not carry into main().
const graphConfig = maybeGraphConfig;

/**
 * This process's own account at the issuer. The credential authenticates the
 * PROCESS; the agent DID it buys names the WORK. See `startAgentSession`.
 */
const issuerUrl = envConfig.services?.identity?.issuer;
if (!issuerUrl) {
  throw new Error('services.identity.issuer is required: a sidecar authenticates at the knowledge base\'s issuer');
}
const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are required to authenticate as a service account');
}
const credential = { issuer: issuerUrl, clientId, clientSecret };

const healthPort = 24102;

// The checkpoint is an optimization, never a correctness input — losing it
// degrades the next catch-up to a full replay. The weaver runs with NO state
// mount (see the supervisor note in main()), so its checkpoint lives in the
// container's ephemeral tmp EXPLICITLY — not an XDG_STATE_HOME that is never
// set for this service, papered over with a fabricated `~/.local/state`:
// absence must fail loudly or be chosen outright, never defaulted.
const checkpointPath = join(tmpdir(), 'semiont', 'weaver-checkpoint.json');

import { createProcessLogger } from '@semiont/observability/process-logger';
import { startAgentSession } from './agent-session';
const logger = createProcessLogger('weaver');

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode, registerSupervisorRestartCount } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-weaver' });
  // Supervised, but with no writable /semiont-state: `supervise.sh` keeps its
  // event log in /tmp and exports the resolved path. That is enough for the
  // LIVE count — the container does not exit when the child restarts — and
  // only surviving container teardown would need a mount, which this service
  // was deliberately not given.
  registerSupervisorRestartCount();

  // The weaver is a Software peer, authenticated as the Smelter is. It has no
  // inference (provider, model), so it authenticates under the stable
  // identity (semiont, weaver) — DID did:web:<host>:agents:semiont:weaver —
  // and the bus stamps that onto every signal it emits.
  //
  // The token's lifetime and the refresh cadence derived from it are the
  // gateway's to decide; see `startAgentSession`.
  const session = await startAgentSession({
    baseUrl,
    credential,
    provider: 'semiont',
    model: 'weaver',
    logger,
  });

  const graphDb = await withDeadline('Graph database', STARTUP_CONNECT_TIMEOUT_MS,
    () => getGraphDatabase(graphConfig), RESTART_HINT);
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
  const fanIn = weaverFanIn(httpTransport.actor);

  // Production timings (the axiom harness runs ~1 ms).
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
    fanIn.events$,
    fanIn.rebuilds$,
    httpTransport,
    new FileWeaverCheckpoint(checkpointPath),
    timing,
    logger,
  );
  await weaver.initialize();
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
  // NOT fatal. "A weaver that cannot catch up is projecting a graph of unknown
  // freshness" is true, but exiting does not make the graph fresher, and
  // exiting here would guard only this ~30 s window: a subscription that drops
  // silently an hour later leaves exactly the same stale graph. What exiting
  // would guarantee is that one 429 removes the weaver entirely. The failed
  // phase is recorded and logged; the live subscription keeps running.
  await runBootPass('catch-up', () => weaver.catchUp(), logger, (s) => { catchUpState = s; });

  // Reconcile pass: the state-diff backstop for divergence the
  // accounting cannot witness — out-of-band mutations, wiped/rolled-back
  // graph volumes, historical damage. Also non-fatal; heal failures are
  // reported in the summary rather than thrown.
  await runBootPass('reconcile', () => weaver.reconcile(), logger, (s) => { reconcileState = s; });
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
