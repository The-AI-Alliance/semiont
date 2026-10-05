/**
 * Librarian Main — standalone entry point
 *
 * The reference desk: searches the collection and hands back what is
 * relevant — ranked or assembled — for an inquiry that belongs to someone
 * else. Never concludes anything; concluding is the Generator's job. Runs
 * the LLM-bound actors: `Matcher` (candidate search + scoring for the bind
 * flow) and `Gatherer` (LLM context assembly for the gather flows), plus
 * the handlers that run beside them: the gather-summary handler, which
 * calls the Gatherer, and the two retrieval handlers, which answer text
 * search (`match:resources-requested`) and what refers to a resource
 * (`gather:referenced-by-requested`) from the graph and the vectors.
 *
 * Its attachments are the bus (HttpTransport: SSE in, `/bus/emit` out),
 * Neo4j and Qdrant (the retrieval sources), an embedding provider (query
 * embedding), per-actor inference clients, content from the Archivist
 * (bytes ride the byte path, keyed by resource id; this process reads them
 * from the record's storage authority, like the smelter does), and views
 * from the shared stateDir the Archivist materializes into (a reader
 * mounts it shared and never rebuilds). The weave/smelt progress folds run
 * locally, fed by the same `weave:applied` / `smelt:settled` signals over
 * SSE, so the graph grace and the settle barrier work unchanged. This
 * process appends nothing, serves no bytes, and owns no store.
 *
 * Bus wiring is two disjoint pumps on the archivist-main pattern; both
 * rosters live in `service-channels.ts`:
 *   in  — LIBRARIAN_INBOUND_CHANNELS (the actor and retrieval-handler
 *         rosters, each pinned to its real subscriptions by a census gate,
 *         plus the summary handler's channel and the two progress signals); SSE frames are pushed onto
 *         the local bus. The transport's SSE subscription is this set plus
 *         LIBRARIAN_REPLY_CHANNELS (the replies to the one read this process
 *         awaits) — never the full bridged set.
 *   out — LIBRARIAN_OUTBOUND_CHANNELS: every reply channel DERIVED from
 *         BUS_OPERATIONS over the inbound set. No strays: every operation
 *         here is keyed under its own request channel, and the progress
 *         signals have no operations so nothing echoes.
 *
 * No fact pump (nothing here persists events), no second HTTP route
 * (nothing dials the Librarian — it dials the gateway), and no view
 * rebuild EVER (the Archivist is the one rebuild owner).
 *
 * No KB mount: this process never touches the KB tree. The one committed
 * fact it needs — the KB name, to find the views the Archivist materializes
 * under the shared state mount — arrives as `[kb] name` in the config the
 * launcher stages, and boot refuses without it.
 *
 * Environment variables:
 *   SEMIONT_OIDC_CLIENT_ID     — this process's own account at the KB's
 *   SEMIONT_OIDC_CLIENT_SECRET   issuer; buys the agent token it shows the
 *                                gateway, and the bearer it shows the Archivist
 *   XDG_STATE_HOME             — the shared state mount the views live under.
 */

import { Subscription } from 'rxjs';
import { createServer } from 'http';
import { HttpTransport } from '@semiont/http-transport';
import { archivistContentReads } from '@semiont/content';
import {
  EventBus,
  baseUrl as makeBaseUrl,
  withDeadline } from '@semiont/core';
import { loadEnvironmentConfig, SemiontState } from '@semiont/core/node';
import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { getGraphDatabase } from '@semiont/graph';
import { createVectorStore, createEmbeddingProvider } from '@semiont/vectors';
import { createInferenceClient } from '@semiont/inference';
import { Matcher } from './matcher';
import { Gatherer } from './gatherer';
import { LIBRARIAN_INBOUND_CHANNELS, LIBRARIAN_OUTBOUND_CHANNELS, LIBRARIAN_REPLY_CHANNELS } from './service-channels';
import { anchoredTextOverBus } from './anchored-text-ask';
import { attachServicePumps } from './service-pumps';
import { createWeaveProgress } from './weave-progress';
import { createSmeltProgress } from './smelt-progress';
import { registerGatherSummaryHandler } from './handlers/gather-summary';
import { registerRetrievalHandlers } from './handlers/resource-retrieval';
import { assertMakeMeaningConfig } from './assert-make-meaning-config';
import { STARTUP_CONNECT_TIMEOUT_MS, RESTART_HINT } from './startup';
import { makeMeaningConfigFrom, requireKBName, resolveActorInference } from './config';

// ── Config ───────────────────────────────────────────────────────────

// No project root: this process has no KB mount, so everything it needs
// rides the staged config (~/.semiontconfig in the container).
const envConfig = loadEnvironmentConfig(null, { service: 'librarian' });
const kbName = requireKBName(envConfig);
const gatewayPublicURL = envConfig.services?.gateway?.publicURL;
if (!gatewayPublicURL) {
  throw new Error('services.gateway.publicURL is required in environment config');
}
const baseUrl: string = gatewayPublicURL;

const config = makeMeaningConfigFrom(envConfig);
// One decider for the config's shape invariants (graph presence, the
// gather barrier nesting inside the stall watchdog) — the same assertion
// the roots in service.ts run: the Gatherer's settle barrier lives in this
// process.
assertMakeMeaningConfig(config);

const maybeGraphConfig = config.services.graph;
if (!maybeGraphConfig?.type) {
  throw new Error('services.graph.type is required for the Librarian');
}
if (maybeGraphConfig.type === 'memory') {
  // Same stance as weaver-main and archivist-main: an in-memory graph lives
  // in one process's heap; the Librarian would search an empty graph forever
  // while looking healthy.
  throw new Error("services.graph.type 'memory' is a test-only sink; the Librarian requires a server-backed graph");
}
// Re-bind after the guards: module-level narrowing does not carry into main().
const graphConfig = maybeGraphConfig;
if (config.services.vectors.type === 'memory') {
  // A memory vector index here can never be shared with the Smelter that
  // fills it — semantic retrieval would return the empty page forever.
  throw new Error("services.vectors.type 'memory' is a test-only sink; the Librarian requires a server-backed vector store");
}

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

/** Claimed as a portNeed in the launcher: worker 24100, smelter 24101, weaver 24102, archivist 24103. */
const healthPort = 24104;

import { createProcessLogger } from '@semiont/observability/process-logger';
import { startAgentSession } from './agent-session';
const logger = createProcessLogger('librarian');

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { initObservabilityNode, registerSupervisorRestartCount } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-librarian' });
  // The Librarian is supervised and mounts /semiont-state, where the
  // supervisor keeps its durable event log: report its restart count.
  registerSupervisorRestartCount();

  // A Software peer under the stable identity (semiont, librarian), the same
  // shape as the Archivist: one DID for the reference desk. NOT the actor's
  // inference pair — this process hosts Matcher and Gatherer, each with its
  // own inference config, under one token.
  //
  // The token's lifetime and the refresh cadence derived from it are the
  // gateway's to decide; see `startAgentSession`.
  const session = await startAgentSession({
    baseUrl,
    credential,
    provider: 'semiont',
    model: 'librarian',
    logger,
  });

  // ── The stores: reads only, nothing owned ──────────────────────────
  const localBus = new EventBus();

  // The one filesystem read: views from the shared stateDir, located by
  // the staged KB name alone — no SemiontProject, no KB root. The
  // Archivist materializes them; this process NEVER rebuilds.
  const state = new SemiontState({ name: kbName });
  const views = new FilesystemViewStorage(state, logger.child({ component: 'view-storage' }));

  logger.info('Connecting to graph database', { type: graphConfig.type });
  // Bounded: an unbounded await on a dependency that is not up leaves the
  // container hung and unhealthy, where `restart: on-failure` only rescues a
  // process that EXITS. The vector store gets the deadline as a signal because
  // creating a collection retries while the embedding model warms up — this stops
  // that retry rather than abandoning it mid-flight.
  const graphDb = await withDeadline('Graph database', STARTUP_CONNECT_TIMEOUT_MS,
    () => getGraphDatabase(graphConfig), RESTART_HINT);

  const embeddingConfig = config.services.embedding;
  logger.info('Connecting to embedding provider', { type: embeddingConfig.type, model: embeddingConfig.model });
  const embeddingProvider = await withDeadline('Embedding provider', STARTUP_CONNECT_TIMEOUT_MS,
    () => createEmbeddingProvider(embeddingConfig), RESTART_HINT);
  const vectorsConfig = config.services.vectors;
  logger.info('Connecting to vector store', { type: vectorsConfig.type });
  const vectorStore = await withDeadline('Vector store', STARTUP_CONNECT_TIMEOUT_MS,
    (signal) => createVectorStore({
      signal,
      type: vectorsConfig.type,
      host: vectorsConfig.host,
      port: vectorsConfig.port,
      dimensions: () => embeddingProvider.dimensions(),
    }), RESTART_HINT);

  // The bus transport. Its pumps attach after the actors subscribe.
  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: session.token$,
    tokenRefresher: session.refresh,
    // The inbound roster plus the awaited-reply channels — never the full
    // bridged set (see service-channels.ts). This process awaits ONE wire
    // reply (the anchored-text ask behind gather's text dispatcher); the
    // census in service-channels.ts pins the list, and busRequest's
    // isSubscribed gate fails fast if an await is ever added without
    // growing it.
    channels: [...LIBRARIAN_INBOUND_CHANNELS, ...LIBRARIAN_REPLY_CHANNELS],
  });
  // Bytes from the Archivist, not the gateway: the gateway's content routes
  // proxy onto this same call, so dialing it would only add a hop. Throws at
  // boot if the address or the credential is absent: the address is
  // `services.archivist` in the loaded config, and the issuer this process
  // authenticates at rides in `credential`.
  const contentReads = archivistContentReads(envConfig, credential);

  // The progress folds, fed by the signals LIBRARIAN_INBOUND_CHANNELS pumps onto the
  // local bus — the graph grace and the settle barrier work exactly as
  // in-process.
  const weaveProgress = createWeaveProgress(localBus);
  const smeltProgress = createSmeltProgress(localBus);

  // ── Actors ─────────────────────────────────────────────────────────
  const matcher = new Matcher(
    { graph: graphDb, views, vectors: vectorStore },
    localBus,
    logger.child({ component: 'matcher' }),
    createInferenceClient(resolveActorInference(config, 'matcher'), logger.child({ component: 'inference-client-matcher' })),
    embeddingProvider,
  );
  await matcher.initialize();

  const gatherer = new Gatherer(
    {
      views,
      content: contentReads,
      // Derived text for pdf-text-layer media: the anchored-text bus read,
      // over this transport (the Archivist answers).
      anchoredText: anchoredTextOverBus(httpTransport),
      graph: graphDb,
      vectors: vectorStore,
      weaveProgress,
      smeltProgress,
    },
    localBus,
    createInferenceClient(resolveActorInference(config, 'gatherer'), logger.child({ component: 'inference-client-gatherer' })),
    config.gather.settleTimeoutMs,
    logger.child({ component: 'gatherer' }),
    embeddingProvider,
  );
  await gatherer.initialize();

  // The summary handler follows its actor: it calls the Gatherer's
  // inference path, so it registers here beside it.
  registerGatherSummaryHandler(localBus, gatherer, logger);

  // Text search and referenced-by: retrieval, answered from the stores this
  // process already holds. Names in their replies come from the people
  // projection, under the same shared state mount as the views.
  const detachRetrieval = registerRetrievalHandlers(
    localBus,
    { graph: graphDb, views, vectors: vectorStore, content: contentReads },
    { embeddingProvider, semanticFloor: config.search.semanticFloor, state },
    logger,
  );

  // ── Bus pumps ──────────────────────────────────────────────────────
  const pumps: Subscription[] = [];

  const outbound = LIBRARIAN_OUTBOUND_CHANNELS;
  pumps.push(
    ...attachServicePumps({
      transport: httpTransport,
      localBus,
      inbound: LIBRARIAN_INBOUND_CHANNELS,
      outbound,
      logger,
    }),
  );

  logger.info('Bus pumps attached', { inbound: LIBRARIAN_INBOUND_CHANNELS.length, outbound: outbound.length });

  // ── Health — listens only AFTER the pumps attach, so the launcher's
  // health gate proves the service is answering, not merely booted (the
  // ordering that closed the Archivist's sidecar boot race). ───────────
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', actors: ['matcher', 'gatherer'] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(healthPort, () => {
    logger.info('Librarian HTTP surface ready', { port: healthPort, paths: ['/health'] });
  });

  const shutdown = () => {
    logger.info('Shutting down');
    session.stop();
    for (const pump of pumps) pump.unsubscribe();
    detachRetrieval();
    httpTransport.dispose();
    void Promise.all([matcher.stop(), gatherer.stop()]).then(async () => {
      weaveProgress.dispose();
      smeltProgress.dispose();
      await graphDb.disconnect();
      localBus.destroy();
      server.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Librarian serving', { channels: LIBRARIAN_INBOUND_CHANNELS.length });
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
