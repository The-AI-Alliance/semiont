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
 * No KB mount, no graph, no vectors, no views, no content, no state mount:
 * unlike the other make-meaning sidecars, the dispatcher touches none of the
 * knowledge system and mounts nothing. It needs the gateway (its token and the
 * plane) and the messaging broker (the JetStream queue), both named by its
 * configuration document.
 *
 * Inputs:
 *   --config <path>            — its configuration document (DispatcherConfig in
 *                                the spec); the image passes /etc/semiont/dispatcher.json.
 *   SEMIONT_OIDC_CLIENT_ID     — this process's own account at the KB's
 *   SEMIONT_OIDC_CLIENT_SECRET   issuer; buys the agent token it shows the gateway.
 *   the broker credentials     — the variables the document's `queue` names.
 */

import { Subscription } from 'rxjs';
import { createServer } from 'http';
import { HttpTransport } from '@semiont/http-transport';
import { EventBus, baseUrl as makeBaseUrl, withDeadline } from '@semiont/core';
import { JetStreamJobQueue } from '@semiont/jobs';
import { registerJobQueueProvider } from '@semiont/observability';
import { createProcessLogger } from '@semiont/observability/process-logger';
import { startAgentSession } from './agent-session';
import { RESTART_HINT } from './service';
import { configPathFrom, readDispatcherConfig, namedSecret, type DispatcherConfig } from './dispatcher-config';
import { registerJobCommandHandlers } from './handlers/job-commands';
import { DISPATCHER_INBOUND_CHANNELS, DISPATCHER_OUTBOUND_CHANNELS, DISPATCHER_REPLY_CHANNELS } from './service-channels';
import { projectionReadsOverBus } from './projection-reads-ask';
import { attachServicePumps } from './service-pumps';

// ── Config ───────────────────────────────────────────────────────────
//
// One document, named by `--config` and validated against DispatcherConfig in
// the spec; the launcher writes it resolved. The service account is the only
// other input it reads by name, and the broker's credentials are the
// variables the document names. A refusal here ends the process before it
// serves, with the reason on stderr.
function loadConfig(): DispatcherConfig {
  try {
    return readDispatcherConfig(configPathFrom(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[fatal] ${(error as Error).message}\n`);
    process.exit(1);
  }
}
const config = loadConfig();

/**
 * This process's own account at the issuer. The credential authenticates the
 * PROCESS; the agent DID it buys names the WORK. See `startAgentSession`.
 */
const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are required to authenticate as a service account');
}
const credential = { issuer: config.identity.issuer, clientId, clientSecret };

const logger = createProcessLogger('dispatcher', { level: config.logLevel, format: config.logFormat });

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode, registerSupervisorRestartCount } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-dispatcher' });
  registerSupervisorRestartCount();

  // A Software peer under the stable identity (semiont, dispatcher): one DID
  // for the control plane, the same shape the Archivist and Librarian use.
  // The token's lifetime and refresh cadence are the gateway's to decide.
  const session = await startAgentSession({
    baseUrl: config.gatewayUrl,
    credential,
    provider: 'semiont',
    model: 'dispatcher',
    logger,
  });

  const localBus = new EventBus();

  // ── The queue ──────────────────────────────────────────────────────
  // JetStream, on the broker and with the clocks the document names. Its
  // initialize() connects to the broker, so it takes the boot deadline: a slow
  // dependency on a restart-everything-at-once resume must make the process
  // EXIT rather than hang unhealthy (the archivist-main pattern).
  const jobQueue = new JetStreamJobQueue({
    servers: config.queue.servers,
    user: namedSecret('queue.userEnv', config.queue.userEnv),
    pass: namedSecret('queue.passwordEnv', config.queue.passwordEnv),
    tickMs: config.timing.tickMs,
    staleRunningMs: config.timing.staleRunningMs,
    ackWaitMs: config.timing.ackWaitMs,
    retentionMs: config.timing.retentionMs,
    retentionSweepMs: config.timing.retentionSweepMs,
    progressWriteIntervalMs: config.timing.progressWriteIntervalMs,
  }, logger.child({ component: 'job-queue' }), localBus);
  await withDeadline('Job queue', config.timing.bootDeadlineMs, () => jobQueue.initialize(), RESTART_HINT);

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
    baseUrl: makeBaseUrl(config.gatewayUrl),
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
      res.end(JSON.stringify({ status: 'ok', queue: 'jetstream' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.port, () => {
    logger.info('Dispatcher HTTP surface ready', { port: config.port, paths: ['/health'] });
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
