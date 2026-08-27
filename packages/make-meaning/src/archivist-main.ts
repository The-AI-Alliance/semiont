/**
 * Archivist Main — standalone entry point (EXTRACT-ARCHIVIST P2a)
 *
 * The service that keeps the system of record. Runs the three actors that
 * own the file-backed state — `Stower` (accessions: events + projections),
 * `Browser` (serves: `browse:*` reads), `CloneTokenManager` (resource
 * lifecycle) — against LOCAL stores: the event log, materialized views, the
 * git working tree, anchored text. Its network attachments are the bus
 * (HttpTransport: SSE in, `/bus/emit` out), Neo4j (one query —
 * `browse:referenced-by`), and the embedding provider (Browser's semantic
 * search fallback). Per GATEWAY.md D4a it serves NO bytes: the gateway is
 * the content server; this process only registers/moves/removes/resolves.
 *
 * Bus wiring is two disjoint pumps, deliberately NOT `bridgeInto`:
 *   in  — the actors' channel rosters (STOWER/BROWSER/CLONE_TOKEN_CHANNELS,
 *         each pinned to its actor's real subscriptions by a census gate)
 *         plus `smelt:settled` for the anchored-text barrier fold; SSE
 *         frames are pushed onto the local bus the actors subscribe to.
 *   out — every reply channel DERIVED from BUS_OPERATIONS over the inbound
 *         set, plus three strays whose operations are keyed under gateway
 *         handler channels (see OUTBOUND_STRAYS). Requests and replies never
 *         overlap, so nothing echoes.
 *
 * ⚠️ Known cutover gap, deliberate at P2a ("an image nothing launches yet"):
 * domain events appended here publish on the LOCAL core bus only — they do
 * not yet reach the gateway's SSE feed (that seam is EXTRACT-BUS's terrain).
 * Until the cutover lands, the gateway keeps running its own in-process
 * actors; running this service beside it duplicates replies, which clients
 * dedup by deterministic e-ids.
 *
 * Environment variables:
 *   SEMIONT_ROOT              — project root (the KB directory). Required.
 *   SEMIONT_ANCHORED_TEXT_DIR — anchored-text store dir. Required.
 *   SEMIONT_WORKER_SECRET     — shared secret: agent auth to the gateway AND
 *                               the bearer the D1 read path requires.
 *   SEMIONT_SKIP_REBUILD      — 'true' skips the startup view rebuild.
 */

import { BehaviorSubject, Subscription } from 'rxjs';
import { HttpTransport } from '@semiont/http-transport';
import {
  EventBus,
  BUS_OPERATIONS,
  baseUrl as makeBaseUrl,
  accessToken as makeAccessToken,
  retryWithBackoff,
  isTransientFetchError,
  STARTUP_FETCH_RETRY,
  errField,
  type AccessToken,
  type EventMap,
} from '@semiont/core';
import { SemiontProject, loadEnvironmentConfig } from '@semiont/core/node';
import { createEventStore } from '@semiont/event-sourcing';
import { WorkingTreeStore, createAnchoredTextStore } from '@semiont/content';
import { getGraphDatabase } from '@semiont/graph';
import { createVectorStore, createEmbeddingProvider } from '@semiont/vectors';
import { Stower, STOWER_CHANNELS } from './stower';
import { Browser, BROWSER_CHANNELS } from './browser';
import { CloneTokenManager, CLONE_TOKEN_CHANNELS } from './clone-token-manager';
import { createSmeltProgress } from './smelt-progress';
import { createLimitsDiscovery } from './limits-discovery';
import { makeMeaningConfigFrom } from './config';
import { createArchivistServer } from './archivist-read-path';

// ── Config ───────────────────────────────────────────────────────────

const maybeRoot = process.env.SEMIONT_ROOT;
if (!maybeRoot) {
  throw new Error('SEMIONT_ROOT environment variable is not set');
}
const projectRoot: string = maybeRoot;
const maybeAnchoredTextDir = process.env.SEMIONT_ANCHORED_TEXT_DIR;
if (!maybeAnchoredTextDir) {
  throw new Error('SEMIONT_ANCHORED_TEXT_DIR environment variable is not set');
}
const anchoredTextDir: string = maybeAnchoredTextDir;

const envConfig = loadEnvironmentConfig(projectRoot);
const backendPublicURL = envConfig.services?.backend?.publicURL;
if (!backendPublicURL) {
  throw new Error('services.backend.publicURL is required in environment config');
}
const baseUrl: string = backendPublicURL;

const config = makeMeaningConfigFrom(envConfig);

const maybeGraphConfig = config.services.graph;
if (!maybeGraphConfig?.type) {
  throw new Error('services.graph.type is required for the Archivist');
}
if (maybeGraphConfig.type === 'memory') {
  // Same stance as weaver-main: an in-memory graph lives in one process's
  // heap; the Archivist would answer `browse:referenced-by` from an empty
  // graph forever while looking healthy.
  throw new Error("services.graph.type 'memory' is a test-only sink; the Archivist requires a server-backed graph");
}
// Re-bind after the guards: module-level narrowing does not carry into main().
const graphConfig = maybeGraphConfig;
if (config.services.vectors.type === 'memory') {
  // A memory vector index here can never be shared with the Smelter that
  // fills it — semantic search would return the empty page forever.
  throw new Error("services.vectors.type 'memory' is a test-only sink; the Archivist requires a server-backed vector store");
}

const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';
const skipRebuild = process.env.SEMIONT_SKIP_REBUILD === 'true';

/** Claimed as a portNeed in the launcher (P2b): worker 9090, smelter 9091, weaver 9092. */
const healthPort = 9093;

import { createProcessLogger } from '@semiont/observability/process-logger';
const logger = createProcessLogger('archivist');

// ── Bus roster ───────────────────────────────────────────────────────

/** Everything the actors subscribe to, plus the smelt barrier's fold input. */
const INBOUND_CHANNELS = [
  ...STOWER_CHANNELS,
  ...BROWSER_CHANNELS,
  ...CLONE_TOKEN_CHANNELS,
  'smelt:settled',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Reply channels the Archivist emits for operations whose REGISTRY KEY is a
 * gateway-handler channel, not one of our inbound channels — so the
 * BUS_OPERATIONS derivation below cannot see them. Each is named with its
 * owner; anything else belongs in the derivation, never here.
 */
const OUTBOUND_STRAYS = [
  'mark:create-failed',      // op keyed 'mark:create-request' (gateway handler re-emits mark:create)
  'mark:body-update-failed', // op keyed 'bind:update-body' (gateway handler re-emits mark:update-body)
  'yield:move-failed',       // yield:mv has no registered operation; failure is direct-subscribed
] as const satisfies readonly (keyof EventMap)[];

function outboundChannels(): (keyof EventMap)[] {
  const out = new Set<keyof EventMap>(OUTBOUND_STRAYS);
  for (const ch of INBOUND_CHANNELS) {
    const op = BUS_OPERATIONS[ch as keyof typeof BUS_OPERATIONS];
    if (!op) continue;
    out.add(op.result);
    out.add(op.failure);
    if ('progress' in op && op.progress) out.add(op.progress);
  }
  return [...out];
}

// ── Auth ─────────────────────────────────────────────────────────────

async function authenticate(): Promise<string> {
  if (!workerSecret) {
    logger.warn('No SEMIONT_WORKER_SECRET set — using empty token');
    return '';
  }

  // A Software peer under the stable identity (semiont, archivist), the same
  // shape as the Weaver: no inference pair, one DID for the record-keeper.
  return retryWithBackoff(
    async () => {
      const response = await fetch(`${baseUrl}/api/tokens/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: workerSecret,
          provider: 'semiont',
          model: 'archivist',
        }),
      });

      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }

      const { token } = await response.json() as { token: string; did: string };
      return token;
    },
    isTransientFetchError,
    STARTUP_FETCH_RETRY,
    ({ attempt, attempts, delayMs, error }) => {
      logger.warn('Backend unreachable, retrying authentication', {
        attempt,
        attempts,
        retryInMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-archivist' });

  logger.info('Authenticating', { baseUrl });
  const tokenSubject = new BehaviorSubject<AccessToken | null>(makeAccessToken(await authenticate()));
  logger.info('Authenticated');

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

  // ── The record: local, single-owner ────────────────────────────────
  const project = new SemiontProject(projectRoot, { anchoredTextDir });
  const localBus = new EventBus();

  const eventStore = createEventStore(project, localBus, logger.child({ component: 'event-store' }));
  if (!skipRebuild) {
    // The Browser reads views, so they must be populated before any request
    // is served — same startup contract as createKnowledgeBase.
    logger.info('Rebuilding materialized views from the event log');
    await eventStore.views.rebuildAll(eventStore.log);
  }
  const views = eventStore.viewStorage;
  const content = new WorkingTreeStore(project, logger.child({ component: 'working-tree-store' }));
  const anchoredText = createAnchoredTextStore(anchoredTextDir, logger.child({ component: 'anchored-text-store' }));
  const smeltProgress = createSmeltProgress(localBus);

  logger.info('Connecting to graph database', { type: graphConfig.type });
  const graphDb = await getGraphDatabase(graphConfig);

  const embeddingConfig = config.services.embedding;
  logger.info('Connecting to embedding provider', { type: embeddingConfig.type, model: embeddingConfig.model });
  const embeddingProvider = await createEmbeddingProvider(embeddingConfig);
  const vectorsConfig = config.services.vectors;
  logger.info('Connecting to vector store', { type: vectorsConfig.type });
  const vectorStore = await createVectorStore({
    type: vectorsConfig.type,
    host: vectorsConfig.host,
    port: vectorsConfig.port,
    dimensions: () => embeddingProvider.dimensions(),
  });

  // ── Actors ─────────────────────────────────────────────────────────
  const stower = new Stower(
    { content, eventStore },
    localBus, project, logger.child({ component: 'stower' }),
  );
  await stower.initialize();

  const limitsDiscovery = createLimitsDiscovery(config, logger.child({ component: 'limits-discovery' }));
  const browser = new Browser(
    { views, eventStore, graph: graphDb, vectors: vectorStore, content, anchoredText, smeltProgress },
    localBus, project, config, limitsDiscovery, embeddingProvider, logger.child({ component: 'browser' }),
  );
  await browser.initialize();

  const cloneTokenManager = new CloneTokenManager(
    { views, content },
    localBus, logger.child({ component: 'clone-token-manager' }),
  );
  await cloneTokenManager.initialize();

  // ── Bus pumps ──────────────────────────────────────────────────────
  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: tokenSubject,
    tokenRefresher: refreshToken,
  });

  const pumps: Subscription[] = [];

  httpTransport.actor.addChannels([...INBOUND_CHANNELS]);
  for (const channel of INBOUND_CHANNELS) {
    pumps.push(
      httpTransport.stream(channel).subscribe((payload) => {
        localBus.get(channel).next(payload as never);
      }),
    );
  }

  const outbound = outboundChannels();
  for (const channel of outbound) {
    pumps.push(
      localBus.get(channel).subscribe((payload) => {
        httpTransport.emit(channel, payload as never).catch((error: unknown) => {
          logger.error('Reply forwarding failed', { channel, error: errField(error) });
        });
      }),
    );
  }
  logger.info('Bus pumps attached', { inbound: INBOUND_CHANNELS.length, outbound: outbound.length });

  // ── Health + the D1 read path ──────────────────────────────────────
  const server = createArchivistServer({
    events: eventStore.log,
    workerSecret,
    health: () => ({
      status: 'ok',
      actors: ['stower', 'browser', 'cloneTokenManager'],
    }),
    logger,
  });
  server.listen(healthPort, () => {
    logger.info('Archivist HTTP surface ready', { port: healthPort, paths: ['/health', '/events/:resourceId'] });
  });

  const shutdown = () => {
    logger.info('Shutting down');
    clearInterval(reauthTimer);
    for (const pump of pumps) pump.unsubscribe();
    httpTransport.dispose();
    void Promise.all([stower.stop(), browser.stop(), cloneTokenManager.stop()]).then(() => {
      smeltProgress.dispose();
      localBus.destroy();
      server.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Archivist serving', { channels: INBOUND_CHANNELS.length });
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
