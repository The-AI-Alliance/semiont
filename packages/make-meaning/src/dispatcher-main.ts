/**
 * Dispatcher Main — standalone entry point (EXTRACT-JOBS P1)
 *
 * The dispatcher is where a worker — ours today, foreign later — goes to ask
 * *what work is available* and to *report what it finished*. It owns the job
 * queue and answers the `job:*` lifecycle commands. It is a CONTROL PLANE
 * (D5): ids, types, params and status flow through it; content bytes and the
 * resulting annotations never do — those ride worker↔Archivist directly. It
 * dispatches and records; it does not perform (that is the `worker`, D1).
 *
 * **This is P1: the service running NOTHING.** It stands the process up —
 * config, a service-account session, an attachment to the plane, and a health
 * check — so that when P2 moves the queue and the `job:*` handlers into it, a
 * failure is unambiguously P2's. The queue (a JetStream client, with the
 * boot-deadline machinery `archivist-main.ts` models via
 * `STARTUP_CONNECT_TIMEOUT_MS`/`RESTART_HINT`) and the inbound/outbound rosters
 * arrive in P2 — the `channels: []` below is the seam they fill.
 *
 * Bus wiring will be two disjoint pumps on the archivist-main pattern
 * (`service-channels.ts`), never `bridgeInto`. None of it exists yet — a
 * control plane running nothing subscribes to nothing.
 *
 * No KB mount, no graph, no vectors, no views, no content: unlike the other
 * make-meaning sidecars, the dispatcher touches none of the knowledge system.
 * It needs only the gateway (for its token and, at P2, the plane) and — at P2
 * — the messaging broker for the queue.
 *
 * Environment variables:
 *   SEMIONT_OIDC_CLIENT_ID     — this process's own account at the KB's
 *   SEMIONT_OIDC_CLIENT_SECRET   issuer; buys the agent token it shows the gateway.
 */

import { createServer } from 'http';
import { HttpTransport } from '@semiont/http-transport';
import { baseUrl as makeBaseUrl } from '@semiont/core';
import { loadEnvironmentConfig } from '@semiont/core/node';
import { createProcessLogger } from '@semiont/observability/process-logger';
import { startAgentSession } from './agent-session';

// ── Config ───────────────────────────────────────────────────────────
//
// No project root: the dispatcher has no KB mount, so everything it needs
// rides the staged config (~/.semiontconfig in the container). `[services.jobs]`
// is present and names `${NATS_HOST}` — resolved eagerly at load by every
// process that reads this config — so the launcher stages `NATS_HOST` for this
// container as it does for the rest; the dispatcher does not READ the queue
// config until P2.
const envConfig = loadEnvironmentConfig(null);

const gatewayPublicURL = envConfig.services?.gateway?.publicURL;
if (!gatewayPublicURL) {
  throw new Error('services.gateway.publicURL is required in environment config');
}
const baseUrl: string = gatewayPublicURL;

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
  // Supervised and mounting /semiont-state (C4: the state volume rides
  // unconditionally, so the fs job driver is never silently mountless), so the
  // durable supervisor record already exists here.
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

  // Attach to the plane. P1 subscribes to nothing — the queue and the `job:*`
  // handler rosters land in P2, which replaces `channels: []` with the
  // dispatcher's inbound roster + awaited-reply channels (never the full
  // bridged set, whose global reply fan-out is the worker-OOM failure mode).
  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: session.token$,
    tokenRefresher: session.refresh,
    channels: [],
  });

  // ── Health — listens last, so the launcher's health gate proves the
  // service authenticated and attached, not merely that the process is up. ──
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // No actors yet — P2 populates this as the queue and handlers land.
      res.end(JSON.stringify({ status: 'ok', actors: [] }));
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
    httpTransport.dispose();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Dispatcher serving (running nothing — EXTRACT-JOBS P1)');
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
