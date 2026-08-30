/**
 * Librarian Main — standalone entry point (EXTRACT-LIBRARIAN P1 + P3)
 *
 * The reference desk: searches the collection and hands back what is
 * relevant — ranked or assembled — for an inquiry that belongs to someone
 * else. Never concludes anything; concluding is the Generator's job. Runs
 * the LLM-bound actors: `Matcher` (candidate search + scoring for the bind
 * flow) and `Gatherer` (LLM context assembly for the gather flows), plus
 * the gather-summary handler that calls the Gatherer (the fact-consumers-
 * follow-the-actor pattern, D2 i).
 *
 * Its attachments are the bus (HttpTransport: SSE in, `/bus/emit` out),
 * Neo4j and Qdrant (the retrieval sources), an embedding provider (query
 * embedding), per-actor inference clients, content from the Archivist
 * (D-CONTENT b — bytes ride the byte path; this process reads them from
 * the record's storage authority, like the smelter does), and views
 * from the shared stateDir the Archivist materializes into (D6 — reader
 * mounts shared, never rebuilds). The weave/smelt progress folds run
 * locally, fed by the same `weave:applied` / `smelt:settled` signals over
 * SSE, so the graph grace and the settle barrier work unchanged. This
 * process appends nothing, serves no bytes, and owns no store.
 *
 * Bus wiring is two disjoint pumps on the archivist-main pattern:
 *   in  — MATCHER_CHANNELS + GATHERER_CHANNELS (each pinned to its actor's
 *         real subscriptions by a census gate) + `gather:summary-requested`
 *         (the handler's channel) + the two progress signals; SSE frames
 *         are pushed onto the local bus.
 *   out — every reply channel DERIVED from BUS_OPERATIONS over the inbound
 *         set. No strays: every operation here is keyed under its own
 *         request channel, and the progress signals have no operations so
 *         nothing echoes.
 *
 * No fact pump (nothing here persists events), no second HTTP route
 * (nothing dials the Librarian — it dials the gateway), and no view
 * rebuild EVER (the Archivist is the one rebuild owner).
 *
 * No KB mount (SINGLE-KB-MOUNT P1): this process never touches the KB tree.
 * The one committed fact it needs — the KB name, to find the views the
 * Archivist materializes under the shared state mount — arrives as
 * `[kb] name` in the staged config (D4), and boot refuses without it.
 *
 * Environment variables:
 *   SEMIONT_WORKER_SECRET     — shared secret for agent auth to the gateway.
 *   XDG_STATE_HOME            — the shared state mount the views live under.
 */

import { BehaviorSubject, Subscription } from 'rxjs';
import { createServer } from 'http';
import { HttpTransport } from '@semiont/http-transport';
import { archivistContentReads } from '@semiont/content';
import {
  EventBus,
  BUS_OPERATIONS,
  baseUrl as makeBaseUrl,
  accessToken as makeAccessToken,
  retryWithBackoff,
  isTransientFetchError,
  STARTUP_FETCH_RETRY,
  type AccessToken,
  type EventMap,
} from '@semiont/core';
import { loadEnvironmentConfig, stateDirFor } from '@semiont/core/node';
import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { getGraphDatabase } from '@semiont/graph';
import { createVectorStore, createEmbeddingProvider } from '@semiont/vectors';
import { createInferenceClient } from '@semiont/inference';
import { Matcher, MATCHER_CHANNELS } from './matcher';
import { Gatherer, GATHERER_CHANNELS } from './gatherer';
import { createWeaveProgress } from './weave-progress';
import { createSmeltProgress } from './smelt-progress';
import { registerGatherSummaryHandler } from './handlers/annotation-lookups';
import { assertMakeMeaningConfig } from './service';
import { makeMeaningConfigFrom, requireKBName, resolveActorInference } from './config';

// ── Config ───────────────────────────────────────────────────────────

// No project root: this process has no KB mount, so everything it needs
// rides the staged config (~/.semiontconfig in the container).
const envConfig = loadEnvironmentConfig(null);
const kbName = requireKBName(envConfig);
const backendPublicURL = envConfig.services?.backend?.publicURL;
if (!backendPublicURL) {
  throw new Error('services.backend.publicURL is required in environment config');
}
const baseUrl: string = backendPublicURL;

const config = makeMeaningConfigFrom(envConfig);
// One decider for the config's shape invariants (graph presence, the A4
// gather-barrier nesting) — the same assertion the other composition roots
// run, now that the Gatherer's settle barrier lives in this process.
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

const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';

/** Claimed as a portNeed in the launcher: worker 9090, smelter 9091, weaver 9092, archivist 9093. */
const healthPort = 9094;

import { createProcessLogger } from '@semiont/observability/process-logger';
const logger = createProcessLogger('librarian');

// ── Bus roster ───────────────────────────────────────────────────────

/**
 * The actors' rosters, the gather-summary handler's channel, and the two
 * progress SIGNALS the local folds consume (`weave:applied` for the graph
 * grace, `smelt:settled` for the settle barrier — the archivist-main
 * precedent). Signals have no BUS_OPERATIONS entries, so the outbound
 * derivation ignores them and nothing echoes.
 */
const INBOUND_CHANNELS = [
  ...MATCHER_CHANNELS,
  ...GATHERER_CHANNELS,
  'gather:summary-requested',
  'weave:applied',
  'smelt:settled',
] as const satisfies readonly (keyof EventMap)[];

function outboundChannels(): (keyof EventMap)[] {
  const out = new Set<keyof EventMap>();
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

  // A Software peer under the stable identity (semiont, librarian), the same
  // shape as the Archivist: one DID for the reference desk. NOT the actor's
  // inference pair — this process hosts Matcher now and Gatherer at P3, each
  // with its own inference config, under one token.
  return retryWithBackoff(
    async () => {
      const response = await fetch(`${baseUrl}/api/tokens/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: workerSecret,
          provider: 'semiont',
          model: 'librarian',
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
  initObservabilityNode({ serviceName: 'semiont-librarian' });

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

  // ── The stores: reads only, nothing owned ──────────────────────────
  const localBus = new EventBus();

  // The one filesystem read: views from the shared stateDir (D6), located
  // by the staged KB name alone — no SemiontProject, no KB root. The
  // Archivist materializes them; this process NEVER rebuilds.
  const views = new FilesystemViewStorage(
    { stateDir: stateDirFor(kbName) },
    logger.child({ component: 'view-storage' }),
  );

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

  // The bus transport. Its pumps attach after the actors subscribe.
  const httpTransport = new HttpTransport({
    baseUrl: makeBaseUrl(baseUrl),
    token$: tokenSubject,
    tokenRefresher: refreshToken,
  });
  // Bytes from the Archivist, not the gateway (SINGLE-KB-MOUNT P4): the
  // gateway's content routes proxy onto this same call, so dialing it added
  // a hop and put the process that is meant to stop touching the KB tree on
  // the path to it. Throws at boot if the address or worker secret is absent.
  const contentReads = archivistContentReads(config);

  // The progress folds, fed by the signals INBOUND_CHANNELS pumps onto the
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
    { views, content: contentReads, graph: graphDb, vectors: vectorStore, weaveProgress, smeltProgress },
    localBus,
    createInferenceClient(resolveActorInference(config, 'gatherer'), logger.child({ component: 'inference-client-gatherer' })),
    config.gather.settleTimeoutMs,
    logger.child({ component: 'gatherer' }),
    embeddingProvider,
  );
  await gatherer.initialize();

  // The summary handler follows its actor (the D2-i pattern): it calls the
  // Gatherer's inference path, so it registers here beside it.
  registerGatherSummaryHandler(localBus, gatherer, logger);

  // ── Bus pumps ──────────────────────────────────────────────────────
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
          logger.error('Reply forwarding failed', {
            channel,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }),
    );
  }

  logger.info('Bus pumps attached', { inbound: INBOUND_CHANNELS.length, outbound: outbound.length });

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
    clearInterval(reauthTimer);
    for (const pump of pumps) pump.unsubscribe();
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

  logger.info('Librarian serving', { channels: INBOUND_CHANNELS.length });
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
