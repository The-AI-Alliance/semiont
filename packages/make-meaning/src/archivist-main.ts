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

import { BehaviorSubject, Subscription, merge, from } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import { HttpTransport } from '@semiont/http-transport';
import {
  EventBus,
  BUS_OPERATIONS,
  PERSISTED_EVENT_TYPES,
  baseUrl as makeBaseUrl,
  accessToken as makeAccessToken,
  retryWithBackoff,
  isTransientFetchError,
  STARTUP_FETCH_RETRY,
  errField,
  type AccessToken,
  type EventMap,
  type StoredEvent,
} from '@semiont/core';
import { SemiontProject, loadEnvironmentConfig } from '@semiont/core/node';
import { createEventStore } from '@semiont/event-sourcing';
import { WorkingTreeStore, createAnchoredTextStore, type AnchoredTextStore } from '@semiont/content';
import { getGraphDatabase } from '@semiont/graph';
import { createVectorStore, createEmbeddingProvider } from '@semiont/vectors';
import { Stower, STOWER_CHANNELS } from './stower';
import { Browser, BROWSER_CHANNELS } from './browser';
import { CloneTokenManager, CLONE_TOKEN_CHANNELS } from './clone-token-manager';
import { createSmeltProgress } from './smelt-progress';
import { createLimitsDiscovery } from './limits-discovery';
import { makeMeaningConfigFrom } from './config';
import { createArchivistServer } from './archivist-read-path';
import { registerAnnotationAssemblyHandler } from './handlers/annotation-assembly';
import { registerAnnotationContextHandler } from './handlers/annotation-lookups';
import { workingTreeContentReads } from './knowledge-base';
import { bootstrapEntityTypes } from './bootstrap/entity-types';
import { wireEnrichment } from './event-enrichment';

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
const gatewayPublicURL = envConfig.services?.gateway?.publicURL;
if (!gatewayPublicURL) {
  throw new Error('services.gateway.publicURL is required in environment config');
}
const baseUrl: string = gatewayPublicURL;

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

/**
 * Everything the actors subscribe to, plus the smelt barrier's fold input,
 * plus `mark:create-request` — annotation-assembly registers HERE beside the
 * Stower whose `mark:added` facts it consumes (EXTRACT-ARCHIVIST P3, D2 i).
 */
const INBOUND_CHANNELS = [
  ...STOWER_CHANNELS,
  ...BROWSER_CHANNELS,
  ...CLONE_TOKEN_CHANNELS,
  'mark:create-request',
  'smelt:settled',
  // The annotation-context read moved here with the bytes (SINGLE-KB-MOUNT D5).
  'browse:annotation-context-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Reply channels the Archivist emits for operations whose REGISTRY KEY is a
 * gateway-handler channel, not one of our inbound channels — so the
 * BUS_OPERATIONS derivation below cannot see them. Each is named with its
 * owner; anything else belongs in the derivation, never here.
 */
const OUTBOUND_STRAYS = [
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
      logger.warn('Gateway unreachable, retrying authentication', {
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
    // is served — same startup contract as createKnowledgeBase. The
    // Archivist is the ONE rebuild owner (D6): the gateway never rebuilds,
    // it reads this stateDir.
    logger.info('Rebuilding materialized views from the event log');
    await eventStore.views.rebuildAll(eventStore.log);
  }
  const views = eventStore.viewStorage;
  // Annotation enrichment rides this process's append path (P3): published
  // facts carry their annotation, and the forwarded copies below carry it too.
  wireEnrichment(eventStore, { views });
  const content = new WorkingTreeStore(project, logger.child({ component: 'working-tree-store' }));
  // Read-only from construction (ANCHORED-TEXT-TO-SMELTER D5): this process
  // shares the directory with the store's single writer, so the narrowing —
  // not mere abstinence — is what keeps single-writer true. Widening this
  // type is the regression, not a refactor.
  const anchoredText: Pick<AnchoredTextStore, 'read'> = createAnchoredTextStore(anchoredTextDir, logger.child({ component: 'anchored-text-store' }));
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

  // The fact-consumers follow the facts (P3, D2 i): annotation-assembly
  // subscribes to the mark:added this process's Stower publishes, and its
  // mark:create-ok/-failed replies ride the outbound pump like every reply.
  registerAnnotationAssemblyHandler(localBus, { views }, logger);

  // The annotation-context read follows the same rule (D5): it is a
  // views+content read, and this is the process that holds both. It sat on
  // the gateway only because "the gateway is the byte path" — a premise D1
  // reversed. Here the byte read is the same in-process resolution the HTTP
  // face serves, rather than a hop back to whoever holds the mount.
  registerAnnotationContextHandler(
    localBus,
    { views, content: workingTreeContentReads(views, content) },
    logger,
  );

  // Vocabulary bootstrap emits frame:add-entity-type for missing defaults —
  // handled by our own Stower, in-process, no cross-service boot race (P3).
  await bootstrapEntityTypes(localBus, eventStore, logger.child({ component: 'entity-types-bootstrap' }));

  // The entity-type warm (was gateway index.ts): getEntityTypes() lazily runs
  // initializeTagCollections(), which merges DEFAULT_ENTITY_TYPES into the
  // Neo4j TagCollection and persists it. Seed-and-warm, not a dead read.
  const entityTypes = await graphDb.getEntityTypes();
  logger.info('Entity-type collections warmed', { count: entityTypes.length });

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

  // ── The fact pump (P3, D5): persisted events ride the bus ──────────
  // Every append publishes an (enriched) StoredEvent on this process's bus;
  // this pump emits each one to the gateway via the ordinary /bus/emit —
  // persisted channels are registered there (validate: null), and channel
  // authz is deferred wholesale (CHANNEL-AUTHZ.md). Emitted twice, exactly
  // as in-process appendEvent published: once global (the Smelter's and
  // Weaver's unscoped subscriptions), once resource-scoped (clients'
  // per-resource feeds, whose SSE frames carry the resumable p-<scope>-<seq>
  // ids). Serialized with concatMap: projections downstream assume
  // per-resource ORDER, and parallel emits would reorder. A fact that fails
  // after the transport's retries is logged loudly and NOT retried further —
  // the D1 replay path and the projectors' catch-up/reconcile passes exist
  // for exactly that gap.
  const publishFact = async (event: StoredEvent): Promise<void> => {
    try {
      const type = event.type as keyof EventMap;
      await httpTransport.emit(type, event as never);
      if (event.resourceId) {
        await httpTransport.emit(type, event as never, event.resourceId);
      }
    } catch (error) {
      logger.error('Fact publish failed — projectors will heal on their next catch-up', {
        type: event.type,
        resourceId: event.resourceId,
        sequenceNumber: event.metadata?.sequenceNumber,
        error: errField(error),
      });
    }
  };
  pumps.push(
    merge(...PERSISTED_EVENT_TYPES.map((type) => localBus.getDomainEvent(type)))
      .pipe(concatMap((event) => from(publishFact(event))))
      .subscribe(),
  );

  logger.info('Bus pumps attached', { inbound: INBOUND_CHANNELS.length, outbound: outbound.length, facts: PERSISTED_EVENT_TYPES.length });

  // ── The HTTP surface: health, the D1 read path, the content write path ──
  const server = createArchivistServer({
    events: eventStore.log,
    content,
    views,
    workerSecret,
    health: () => ({
      status: 'ok',
      actors: ['stower', 'browser', 'cloneTokenManager'],
    }),
    // This process holds the tree, so it is the one that can answer (P5).
    branch: () => project.gitBranch(),
    logger,
  });
  server.listen(healthPort, () => {
    logger.info('Archivist HTTP surface ready', { port: healthPort, paths: ['/health', '/events/:resourceId', '/content/:storageUri', '/resources/:id/content'] });
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
