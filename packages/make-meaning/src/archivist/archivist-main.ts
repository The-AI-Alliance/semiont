/**
 * Archivist Main — standalone entry point
 *
 * The service that keeps the system of record. Runs the three actors that
 * own the file-backed state — `Stower` (accessions: events + projections),
 * `Browser` (serves: `browse:*` reads), `CloneTokenManager` (resource
 * lifecycle) — against LOCAL stores: the event log, materialized views, the
 * git working tree, and anchored text (read-only; the Smelter writes it).
 * Its one network attachment is the bus (HttpTransport: SSE in, `/bus/emit`
 * out): it holds no graph, no vector store and no embedding provider —
 * finding things is the Librarian's. Its HTTP surface serves the KB's bytes:
 * the gateway proxies external content requests through it, and internal
 * readers dial it directly.
 *
 * Bus wiring is two disjoint `relayFrames` pumps — not `bridgeInto`, which
 * bridges everything the transport receives; both rosters live in
 * `service-channels.ts`:
 *   in  — ARCHIVIST_INBOUND_CHANNELS (the actors' rosters, each pinned to
 *         its actor's real subscriptions by a census gate, plus the
 *         handlers' request channels and `smelt:settled` for the
 *         anchored-text barrier fold), which is also the transport's whole
 *         SSE subscription — never the full bridged set; SSE frames are
 *         pushed onto the local bus the actors subscribe to.
 *   out — ARCHIVIST_OUTBOUND_CHANNELS: every reply channel DERIVED from
 *         BUS_OPERATIONS over the inbound set, plus the strays no
 *         registered operation names (ARCHIVIST_OUTBOUND_STRAYS). Requests
 *         and replies never overlap, so nothing echoes.
 *
 * Inputs:
 *   --config <path>            — its configuration document (ArchivistConfig in
 *                                the spec); the image passes /etc/semiont/archivist.json.
 *   SEMIONT_OIDC_CLIENT_ID     — this process's own account at the KB's issuer;
 *   SEMIONT_OIDC_CLIENT_SECRET   buys the agent token it shows the gateway. Its
 *                                own read path admits callers by verifying THEIR
 *                                issuer token, not by comparing a shared string.
 *   XDG_STATE_HOME             — the state volume the views are written under.
 */

import { Subscription, merge } from 'rxjs';
import { HttpTransport } from '@semiont/http-transport';
import {
  PERSISTED_EVENT_TYPES,
  BusRequestError,
  ResourceOperations,
  baseUrl as makeBaseUrl,
  busRequest,
  kbResource } from '@semiont/core';
import { IssuerVerifier } from '@semiont/core/identity';
import { SemiontProject } from '@semiont/core/node';
import { ARCHIVIST_INBOUND_CHANNELS, ARCHIVIST_OUTBOUND_CHANNELS } from '../service-channels';
import { attachServicePumps } from '../service-pumps';
import { configPathFrom, readArchivistConfig, type ArchivistConfig } from './archivist-config';
import { createArchivistServer } from './archivist-read-path';
import { createFactPump } from './fact-pump';
import { asBusRequestPrimitive } from '../bus-request-local';
import { composeArchivist } from './compose';

// ── Config ───────────────────────────────────────────────────────────
//
// One document, named by `--config` and validated against ArchivistConfig in
// the spec; the launcher writes it resolved. A refusal here ends the process
// before it serves, with the reason on stderr.
function loadConfig(): ArchivistConfig {
  try {
    return readArchivistConfig(configPathFrom(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
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

import { registerFactPumpDepthProvider } from '@semiont/observability';
import { createProcessLogger } from '@semiont/observability/process-logger';
import { startAgentSession } from '../agent-session';
const logger = createProcessLogger('archivist', { level: config.logLevel, format: config.logFormat });

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-archivist' });

  // Report the supervisor's restart count on its behalf: `supervise.sh` is
  // POSIX shell with no OTel, but it keeps a durable event log and exports
  // its path. A crash LOOP is otherwise invisible to `container logs` alone.
  const { registerSupervisorRestartCount } = await import('@semiont/observability/node');
  registerSupervisorRestartCount();

  // A Software peer under the stable identity (semiont, archivist), the same
  // shape as the Weaver: no inference pair, one DID for the record-keeper.
  //
  // The token's lifetime and the refresh cadence derived from it are the
  // gateway's to decide; see `startAgentSession`.
  const session = await startAgentSession({
    baseUrl: config.gatewayUrl,
    credential,
    provider: 'semiont',
    model: 'archivist',
    logger,
  });

  // ── The record and its actors: local, single-owner ─────────────────
  const archivist = await composeArchivist(
    new SemiontProject(config.root, { anchoredTextDir: config.anchoredTextDir }),
    config.roster,
    logger,
    { skipRebuild: config.skipRebuild, staging: config.staging },
  );
  // `kbDomain` is the audience every token in this knowledge base is minted
  // for: derived from the committed [site] domain with the SAME function the
  // gateway and the launcher use.
  const { bus: localBus, eventStore, views, content, kbDomain } = archivist;

  // ── Bus pumps ──────────────────────────────────────────────────────
  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(config.gatewayUrl),
    token$: session.token$,
    tokenRefresher: session.refresh,
    // Exactly the inbound roster — never the full bridged set (see
    // service-channels.ts). This process awaits no wire replies (busRequest's
    // isSubscribed gate fails fast if one is ever added without growing the
    // roster), so inbound IS the subscription.
    channels: ARCHIVIST_INBOUND_CHANNELS,
  });

  const outbound = ARCHIVIST_OUTBOUND_CHANNELS;
  const pumps: Subscription[] = attachServicePumps({
    transport: httpTransport,
    localBus,
    inbound: ARCHIVIST_INBOUND_CHANNELS,
    outbound,
    logger,
  });

  // ── The fact pump: persisted events ride the bus ───────────────────
  // Every append publishes an (enriched) StoredEvent on this process's bus;
  // the pump emits each one to the gateway via the ordinary /bus/emit —
  // persisted channels are registered there (validate: null), and the
  // gateway applies no channel-level authorization, so any authenticated
  // principal may emit on them. Emitted twice, exactly as appendEvent
  // publishes in-process: once global (the Smelter's and Weaver's unscoped
  // subscriptions), once resource-scoped (clients' per-resource feeds, whose
  // SSE frames carry the resumable p-<scope>-<seq> ids). A fact that fails
  // after the transport's retries is logged loudly and NOT retried further —
  // the sequence-ranged replay read and the projectors' catch-up/reconcile
  // passes exist for exactly that gap.
  //
  // The pump is its own module (`fact-pump.ts`) so that the component whose
  // backlog is the leading suspect for load-correlated heap growth can be
  // tested and measured. Events drain ONE AT A TIME IN ORDER (projections
  // assume per-resource order); the two emits WITHIN one event run together —
  // they address different scopes and have no ordering relation. `depth()` is
  // published as a gauge, so an unbounded backlog has a number.
  const factPump = createFactPump(
    merge(...PERSISTED_EVENT_TYPES.map((type) => localBus.on(type))),
    { emit: (channel, payload, scope) => httpTransport.emit(channel, payload, { scope }), logger },
  );
  pumps.push({ unsubscribe: () => factPump.unsubscribe() } as Subscription);
  registerFactPumpDepthProvider(() => factPump.depth());

  logger.info('Bus pumps attached', { inbound: ARCHIVIST_INBOUND_CHANNELS.length, outbound: outbound.length, facts: PERSISTED_EVENT_TYPES.length });

  // ── The HTTP surface: health, event replay, bytes, descriptions ──────
  // The recording upload and the description ask the actors beside them on
  // this process's own bus: the Stower (or the CloneTokenManager) records,
  // the Browser describes.
  const actors = asBusRequestPrimitive(localBus);
  const server = createArchivistServer({
    events: eventStore.log,
    content,
    views,
    describe: async (id) => {
      try {
        return await busRequest(actors, 'browse:resource-requested', { resourceId: id });
      } catch (error) {
        if (error instanceof BusRequestError && error.code === 'bus.not-found') return undefined;
        throw error;
      }
    },
    record: (upload) =>
      upload.kind === 'clone'
        ? ResourceOperations.createFromCloneToken(upload.input, upload.emitter.did, actors)
        : ResourceOperations.createResource(upload.input, upload.emitter, actors),
    // The Archivist verifies its OWN callers. It serves the event log and
    // accepts byte writes — the most valuable things in the stack — so each
    // caller's issuer token is verified here, never a shared static string.
    verifier: new IssuerVerifier({ issuer: config.identity.issuer, audience: kbResource(kbDomain) }),
    health: () => ({
      status: 'ok',
      actors: ['stower', 'browser', 'cloneTokenManager'],
    }),
    logger,
  });
  server.listen(config.port, () => {
    logger.info('Archivist HTTP surface ready', { port: config.port, paths: ['/health', '/events/:resourceId', 'POST /resources', '/resources/:id/content', '/resources/:id/jsonld'] });
  });

  const shutdown = () => {
    logger.info('Shutting down');
    session.stop();
    for (const pump of pumps) pump.unsubscribe();
    httpTransport.dispose();
    void archivist.stop().then(() => {
      server.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Archivist serving', { channels: ARCHIVIST_INBOUND_CHANNELS.length });
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});