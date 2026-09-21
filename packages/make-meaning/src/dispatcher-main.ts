/**
 * Dispatcher Main — standalone entry point (EXTRACT-JOBS P1 + P2)
 *
 * The dispatcher is where a worker — ours today, foreign later — goes to ask
 * *what work is available* and to *report what it finished*. It owns the job
 * queue and answers the `job:*` lifecycle commands. It is a CONTROL PLANE
 * (D5): ids, types, params and status flow through it; content bytes and the
 * resulting annotations never do — those ride worker↔Archivist directly. It
 * dispatches and records; it does not perform (that is the `worker`, D1).
 *
 * P2 moved the queue and the nine `job:*` handlers off the gateway into here.
 * The gateway now only ROUTES `job:*` frames across the plane to this process;
 * it registers no job handler and holds no queue.
 *
 * Bus wiring is two disjoint pumps on the archivist/librarian pattern
 * (`service-channels.ts`), never `bridgeInto`:
 *   in  — DISPATCHER_INBOUND_CHANNELS: the `job:*` command channels this
 *         process subscribes to, PLUS DISPATCHER_REPLY_CHANNELS — the replies
 *         to the two projection reads `job:create` makes over the bus (D7:
 *         entity types + tag schemas, answered by the Archivist's Browser). The
 *         queue itself still reaches JetStream directly, not over the bus.
 *   out — DISPATCHER_OUTBOUND_CHANNELS: every reply DERIVED from BUS_OPERATIONS
 *         over the inbound set, plus the queue's own `job:queued` broadcast.
 *
 * No KB mount, no graph, no vectors, no views, no content: unlike the other
 * make-meaning sidecars, the dispatcher touches none of the knowledge system.
 * It needs the gateway (its token and the plane), the messaging broker (the
 * JetStream queue), and — only for the fs job driver, the omission-reachable
 * fallback the deployed jetstream config does not use — the shared state mount.
 *
 * Environment variables:
 *   SEMIONT_OIDC_CLIENT_ID     — this process's own account at the KB's
 *   SEMIONT_OIDC_CLIENT_SECRET   issuer; buys the agent token it shows the gateway.
 *   XDG_STATE_HOME             — the shared state mount (fs job driver's jobsDir).
 */

import { Subscription } from 'rxjs';
import { createServer } from 'http';
import { HttpTransport } from '@semiont/http-transport';
import { EventBus, baseUrl as makeBaseUrl, withDeadline } from '@semiont/core';
import { loadEnvironmentConfig, SemiontState } from '@semiont/core/node';
import { registerJobQueueProvider } from '@semiont/observability';
import { createProcessLogger } from '@semiont/observability/process-logger';
import { startAgentSession } from './agent-session';
import { jobQueueFor, STARTUP_CONNECT_TIMEOUT_MS, RESTART_HINT } from './service';
import { makeMeaningConfigFrom, requireKBName } from './config';
import { registerJobCommandHandlers } from './handlers/job-commands';
import { DISPATCHER_INBOUND_CHANNELS, DISPATCHER_OUTBOUND_CHANNELS, DISPATCHER_REPLY_CHANNELS } from './service-channels';
import { projectionReadsOverBus } from './projection-reads-ask';
import { attachServicePumps } from './service-pumps';

// ── Config ───────────────────────────────────────────────────────────
//
// No project root: the dispatcher has no KB mount, so everything it needs
// rides the staged config (~/.semiontconfig in the container). `[services.jobs]`
// selects the driver and names `${NATS_HOST}` for the JetStream one.
const envConfig = loadEnvironmentConfig(null);

const gatewayPublicURL = envConfig.services?.gateway?.publicURL;
if (!gatewayPublicURL) {
  throw new Error('services.gateway.publicURL is required in environment config');
}
const baseUrl: string = gatewayPublicURL;

// The committed KB name locates this KB's state subtree — the fs job driver's
// jobsDir under XDG_STATE_HOME. JetStream ignores it; the fs fallback needs it,
// so like the Librarian this process requires it rather than defaulting.
const kbName = requireKBName(envConfig);
const config = makeMeaningConfigFrom(envConfig);

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

/** Claimed as a portNeed in the launcher: worker 24100, smelter 24101, weaver 24102, archivist 24103, librarian 24104. */
const healthPort = 24105;

const logger = createProcessLogger('dispatcher');

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode, registerSupervisorRestartCount } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-dispatcher' });
  registerSupervisorRestartCount();

  // A Software peer under the stable identity (semiont, dispatcher): one DID
  // for the control plane, the same shape the Archivist and Librarian use.
  // The token's lifetime and refresh cadence are the gateway's to decide.
  const session = await startAgentSession({
    baseUrl,
    credential,
    provider: 'semiont',
    model: 'dispatcher',
    logger,
  });

  const localBus = new EventBus();
  const state = new SemiontState({ name: kbName });

  // ── The queue ──────────────────────────────────────────────────────
  // Selected from config (jetstream in the deployed fleet). Its initialize()
  // connects to the messaging broker, so it takes the boot deadline: a slow
  // dependency on a restart-everything-at-once resume must make the process
  // EXIT rather than hang unhealthy (the archivist-main pattern).
  const jobQueue = jobQueueFor(config.services.jobs, state, logger.child({ component: 'job-queue' }), localBus);
  await withDeadline('Job queue', STARTUP_CONNECT_TIMEOUT_MS, () => jobQueue.initialize(), RESTART_HINT);

  // Tier-3 observability: queue size by status. Exported by THIS process now,
  // not the gateway (the metrics moved with the queue).
  registerJobQueueProvider(() => jobQueue.getStats());

  // The bus transport. Its SSE subscription is the inbound roster PLUS the
  // reply channels for the two projection reads `job:create` makes over the
  // bus (D7): `browse:entity-types-result` / `browse:tag-schemas-result`. It is
  // NOT the full bridged set, whose global reply fan-out is the worker-OOM
  // failure mode; `busRequest`'s isSubscribed probe fails fast if a reply
  // channel is missing from this set.
  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: session.token$,
    tokenRefresher: session.refresh,
    channels: [...DISPATCHER_INBOUND_CHANNELS, ...DISPATCHER_REPLY_CHANNELS],
  });

  // The nine job:* handlers, on the local bus. The pumps below carry their
  // request channels in and their replies (+ the queue's job:queued) out.
  // `job:create` validates entity types and tag schemas by asking the
  // Archivist's Browser over the transport (D7) — it no longer reads the KB's
  // materialized projections off the shared state mount.
  registerJobCommandHandlers(localBus, jobQueue, projectionReadsOverBus(httpTransport), logger);

  // ── Bus pumps ──────────────────────────────────────────────────────
  const pumps: Subscription[] = attachServicePumps({
    transport: httpTransport,
    localBus,
    inbound: DISPATCHER_INBOUND_CHANNELS,
    outbound: DISPATCHER_OUTBOUND_CHANNELS,
    logger,
  });
  logger.info('Bus pumps attached', {
    inbound: DISPATCHER_INBOUND_CHANNELS.length,
    outbound: DISPATCHER_OUTBOUND_CHANNELS.length,
  });

  // ── Health — listens last, so the launcher's health gate proves the queue
  // connected and the pumps attached, not merely that the process is up. ──
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', queue: config.services.jobs?.type ?? 'fs' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(healthPort, () => {
    logger.info('Dispatcher HTTP surface ready', { port: healthPort, paths: ['/health'] });
  });

  const shutdown = () => {
    logger.info('Shutting down');
    session.stop();
    for (const pump of pumps) pump.unsubscribe();
    httpTransport.dispose();
    jobQueue.destroy();
    localBus.destroy();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Dispatcher serving', { channels: DISPATCHER_INBOUND_CHANNELS.length });
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
