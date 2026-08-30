/**
 * Make-Meaning Service
 *
 * Provides a clean interface:
 *   const makeMeaning = await startMakeMeaning(project, config, eventBus, logger);
 */

import { FsJobQueue, STALL_THRESHOLD_MS, type JobQueue } from '@semiont/jobs';
import { createEventStore as createEventStoreCore } from '@semiont/event-sourcing';
import type { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger, jobId } from '@semiont/core';
import { registerJobQueueProvider, registerVectorIndexSizeProvider } from '@semiont/observability';
import { resolveActorInference, type MakeMeaningConfig } from './config';
import { from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { createInferenceClient } from '@semiont/inference';
import { getGraphDatabase } from '@semiont/graph';
import { createKnowledgeBase, workingTreeContentReads } from './knowledge-base';
import { GRAPH_BARRIER_BUDGET_MS } from './graph-context';
import { Gatherer } from './gatherer';
import { Matcher } from './matcher';
import { Stower } from './stower';
import { Browser } from './browser';
import { createLimitsDiscovery } from './limits-discovery';
import { wireEnrichment } from './event-enrichment';
import { CloneTokenManager } from './clone-token-manager';
import { bootstrapEntityTypes } from './bootstrap/entity-types';
import { stopKnowledgeSystem, type KnowledgeSystem, type GatewayKnowledgeSystem } from './knowledge-system';
import { registerBusHandlers, registerGatewayBusHandlers } from './handlers';
import type { Subscription } from 'rxjs';

export type { MakeMeaningConfig } from './config';

export interface MakeMeaningService {
  knowledgeSystem: KnowledgeSystem;
  jobQueue:        JobQueue;
  /**
   * The one SemiontProject this backend is serving — the same instance the
   * KnowledgeSystem, the job queue and the bus handlers were built from.
   *
   * Exposed so request handlers reach for it instead of improvising their own
   * from `config._metadata`. Two of them used to do exactly that, casting an
   * underscore-prefixed field twice per request to rebuild a project that
   * already existed a few frames up — and a project rebuilt that way is
   * missing everything the entry point supplied it with.
   */
  project:         SemiontProject;
  stop:            () => Promise<void>;
}

// ─── Step helpers ─────────────────────────────────────────────────────────────

async function createJobQueue(
  project: SemiontProject,
  eventBus: EventBus,
  logger: Logger,
): Promise<{ jobQueue: JobQueue; jobStatusSubscription: Subscription }> {
  const jobQueueLogger = logger.child({ component: 'job-queue' });
  const jobQueue = new FsJobQueue(project, jobQueueLogger, eventBus);
  await jobQueue.initialize();

  // Tier 3 observability: report queue size by status. The provider is
  // polled at the metric-collection interval (default 30s).
  registerJobQueueProvider(() => jobQueue.getStats());

  const jobStatusSubscription = eventBus.get('job:status-requested').pipe(
    mergeMap((event) => from((async () => {
      try {
        const job = await jobQueue.getJob(jobId(event.jobId));
        if (!job) {
          eventBus.get('job:status-failed').next({ correlationId: event.correlationId, message: 'Job not found' });
          return;
        }
        eventBus.get('job:status-result').next({
          correlationId: event.correlationId,
          response: {
            jobId:       job.metadata.id,
            type:        job.metadata.type,
            status:      job.status,
            userId:      job.metadata.userId,
            created:     job.metadata.created,
            startedAt:   job.status === 'running'   || job.status === 'complete'  ? job.startedAt   : undefined,
            completedAt: job.status === 'complete'  || job.status === 'failed'    || job.status === 'cancelled' ? job.completedAt : undefined,
            error:       job.status === 'failed'    ? job.error    : undefined,
            progress:    job.status === 'running'   ? job.progress : undefined,
            result:      job.status === 'complete'  ? job.result   : undefined,
          },
        });
      } catch (error) {
        eventBus.get('job:status-failed').next({
          correlationId: event.correlationId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })())),
  ).subscribe({
    error: (err) => jobQueueLogger.error('Job status pipeline error', { error: err }),
  });

  return { jobQueue, jobStatusSubscription };
}

// Startup dependency connects are BOUNDED. Docker's `restart: on-failure`
// only rescues a process that EXITS; an unbounded await on a slow dependency
// hangs forever and the container sits unhealthy indefinitely. Observed live
// on a Codespaces resume (2026-07-20): all ten containers restart at once and
// `depends_on` does not apply — it governs `compose up`, not daemon-driven
// restarts — so the backend can reach these connects before Neo4j/Qdrant/
// Ollama are listening. Failing fast turns an unrecoverable hang into a crash
// the restart policy retries until the dependency is up.
export const STARTUP_CONNECT_TIMEOUT_MS = 60_000;

export async function withStartupTimeout<T>(what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what} did not become available within ${STARTUP_CONNECT_TIMEOUT_MS / 1000}s. ` +
                  `Exiting so the container restart policy can retry — it is normal for a dependency ` +
                  `to be slow when every service restarts at once.`,
              ),
            ),
          STARTUP_CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Connect the shared stores both composition roots need: graph, event store,
 * vectors + embedding, and the KnowledgeBase bundle. Whether views REBUILD
 * here is the root's call — the standalone root owns its record and rebuilds;
 * the gateway root never does (D6: the Archivist owns rebuild + incremental,
 * the gateway reads the shared stateDir).
 */
async function connectStores(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  skipRebuild: boolean,
) {
  const graphConfig = config.services!.graph!;
  // Each connect is announced before it is attempted: when one of them does
  // hang, the last line in the log names the culprit. Diagnosing the
  // 2026-07-20 hang took a live investigation precisely because these three
  // steps were silent.
  logger.info('Connecting to graph database', { type: graphConfig.type });
  const graphDb = await withStartupTimeout('Graph database', getGraphDatabase(graphConfig));
  const eventStore = createEventStoreCore(project, eventBus, logger.child({ component: 'event-store' }));

  // The vector pair is mandatory and explicitly configured (MANDATORY-
  // EMBEDDING D0+D1): construction is unconditional — the config NAMES the
  // store and the provider, or the type (and the TOML loader before it)
  // already refused. No fallback path exists; a `memory` choice is an
  // informed one and announces its rebuild-on-restart cost below.
  const vectorsConfig = config.services.vectors;
  const embeddingConfig = config.services.embedding;
  const { createVectorStore, createEmbeddingProvider } = await import('@semiont/vectors');
  logger.info('Connecting to embedding provider', { type: embeddingConfig.type, model: embeddingConfig.model });
  const embeddingProvider = await withStartupTimeout(
    'Embedding provider',
    createEmbeddingProvider(embeddingConfig),
  );
  logger.info('Connecting to vector store', { type: vectorsConfig.type });
  const vectorStore = await withStartupTimeout(
    'Vector store',
    createVectorStore({
      type: vectorsConfig.type,
      host: vectorsConfig.host,
      port: vectorsConfig.port,
      // Dimensionality is discovered from the provider, so it is passed as a
      // thunk rather than probed here: the store calls it only if it needs it
      // (Qdrant, and only to CREATE a collection). This matches how inference
      // treats provider-derived facts — the client is built with no I/O and
      // `limits()` are discovered at the point of use — instead of making a
      // network round-trip a precondition of booting. A `memory` store, or a
      // Qdrant whose collections already exist, never consults the provider.
      dimensions: () => embeddingProvider.dimensions(),
    }),
  );
  if (vectorsConfig.type === 'memory') {
    // L4 breadcrumb: the named cost of the named choice — this index lives
    // in process memory and the Smelter's reconcile re-embeds the whole KB
    // from the event log on every restart.
    // No `dimensions` here on purpose: logging it would resolve the thunk and
    // reinstate the eager provider probe this breadcrumb sits next to.
    logger.info('memory vector store: the index rebuilds from the event log on every restart (reconcile re-embeds)');
  }
  logger.info('Vector search initialized', {
    store: vectorsConfig.type,
    embedding: embeddingConfig.type,
    model: embeddingConfig.model,
  });

  // Tier 3 observability: report index point count. Polled at the
  // metric-collection interval (default 30s).
  registerVectorIndexSizeProvider(() => vectorStore.count());

  const kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, logger, {
    vectorStore,
    skipRebuild,
  });

  return { kb, eventStore, embeddingProvider };
}

async function createKnowledgeSystemFromConfig(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  skipRebuild?: boolean,
): Promise<KnowledgeSystem> {
  const { kb, eventStore, embeddingProvider } = await connectStores(project, config, eventBus, logger, skipRebuild ?? false);

  wireEnrichment(eventStore, kb);

  const stower = new Stower(kb, eventBus, project, logger.child({ component: 'stower' }));
  await stower.initialize();

  await bootstrapEntityTypes(eventBus, eventStore, logger.child({ component: 'entity-types-bootstrap' }));

  const gatherer = new Gatherer(
    // The content capability is ResourceId-keyed (D-CONTENT b); in-process
    // it wraps this root's own working tree behind the transport shape.
    { ...kb, content: workingTreeContentReads(kb.views, kb.content) },
    eventBus,
    createInferenceClient(resolveActorInference(config, 'gatherer'), logger.child({ component: 'inference-client-gatherer' })),
    config.gather.settleTimeoutMs,
    logger.child({ component: 'gatherer' }),
    embeddingProvider,
  );
  await gatherer.initialize();

  const matcher = new Matcher(
    kb, eventBus,
    logger.child({ component: 'matcher' }),
    createInferenceClient(resolveActorInference(config, 'matcher'), logger.child({ component: 'inference-client-matcher' })),
    embeddingProvider,
  );
  await matcher.initialize();

  // The Browser's limits-discovery pool: one guarded client per distinct
  // roster (provider, model); its instances' internal caching is the only
  // storage (INFERENCE-LIMITS-EXPOSURE D1).
  const limitsDiscovery = createLimitsDiscovery(config, logger.child({ component: 'limits-discovery' }));
  const browser = new Browser(kb, eventBus, project, config, limitsDiscovery, embeddingProvider, logger.child({ component: 'browser' }));
  await browser.initialize();

  const cloneTokenManager = new CloneTokenManager(kb, eventBus, logger.child({ component: 'clone-token-manager' }));
  await cloneTokenManager.initialize();

  const ks: KnowledgeSystem = { kb, stower, gatherer, matcher, browser, cloneTokenManager, stop: () => stopKnowledgeSystem(ks) };
  return ks;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function assertMakeMeaningConfig(config: MakeMeaningConfig): void {
  if (!config.services?.graph) {
    throw new Error('services.graph is required for make-meaning service');
  }

  // A4 nesting (SMELTER-INDEX-SYNC): the gather's worst-case read-barrier
  // spend — the settle bound plus the graph barrier budget — must degrade
  // gracefully BEFORE the job-worker stall watchdog fails fast; a barrier
  // that outlives the watchdog gets the worker killed instead of a thin
  // context. Enforced here because both bounds are visible at this
  // composition root; tighter EXTERNAL watchdogs (e.g. my-chat's 90s
  // generation stall) are not importable and remain documented on the
  // config field.
  if (!Number.isFinite(config.gather.settleTimeoutMs) || config.gather.settleTimeoutMs <= 0) {
    throw new Error(`gather.settleTimeoutMs must be a positive number of milliseconds, got ${config.gather.settleTimeoutMs}`);
  }
  if (config.gather.settleTimeoutMs + GRAPH_BARRIER_BUDGET_MS >= STALL_THRESHOLD_MS) {
    throw new Error(
      `gather.settleTimeoutMs (${config.gather.settleTimeoutMs}ms) plus the graph barrier budget (${GRAPH_BARRIER_BUDGET_MS}ms) ` +
      `must nest inside the job-worker stall watchdog (${STALL_THRESHOLD_MS}ms) — lower settleTimeoutMs (A4)`,
    );
  }
}

export async function startMakeMeaning(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  options?: { skipRebuild?: boolean },
): Promise<MakeMeaningService> {
  assertMakeMeaningConfig(config);

  const skipRebuild = options?.skipRebuild ?? (process.env.SEMIONT_SKIP_REBUILD === 'true');

  const { jobQueue, jobStatusSubscription } = await createJobQueue(project, eventBus, logger);
  const knowledgeSystem = await createKnowledgeSystemFromConfig(project, config, eventBus, logger, skipRebuild);

  // Register the bus command handlers that translate caller-facing
  // request channels (mark:create-request, bind:update-body, job:create,
  // browse:annotation-context-requested, gather:summary-requested) into
  // the underlying make-meaning pipeline. Lives here so every transport
  // (HTTP gateway, LocalTransport, future ones) gets the same contract.
  registerBusHandlers(eventBus, knowledgeSystem, jobQueue, project, logger);

  return {
    knowledgeSystem,
    jobQueue,
    project,
    stop: async () => {
      logger.info('Stopping Make-Meaning service');
      jobStatusSubscription.unsubscribe();
      await knowledgeSystem.stop();
      logger.info('Make-Meaning service stopped');
    },
  };
}

// ─── Gateway composition root (EXTRACT-ARCHIVIST P3) ─────────────────────────

export interface GatewayMakeMeaningService {
  knowledgeSystem: GatewayKnowledgeSystem;
  jobQueue:        JobQueue;
  project:         SemiontProject;
  stop:            () => Promise<void>;
}

/**
 * The gateway's composition root: everything startMakeMeaning builds EXCEPT
 * the actors, which have all left. The Archivist (archivist-main) owns
 * Stower/Browser/CloneTokenManager, enrichment, the entity-type bootstrap +
 * warm, and the view rebuild; the Librarian (librarian-main) owns Matcher
 * and Gatherer (EXTRACT-LIBRARIAN P1/P3). What remains here is `kb` reads
 * for the handler subset and the backend's routes, plus the job queue,
 * reading views from the shared stateDir (D6).
 *
 * Views are never rebuilt here — one rebuild owner, one writer (D4b).
 */
export async function startMakeMeaningGateway(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
): Promise<GatewayMakeMeaningService> {
  assertMakeMeaningConfig(config);

  const { jobQueue, jobStatusSubscription } = await createJobQueue(project, eventBus, logger);
  const { kb } = await connectStores(project, config, eventBus, logger, true);

  const knowledgeSystem: GatewayKnowledgeSystem = {
    kb,
    stop: async () => {
      kb.weaveProgress.dispose();
      await kb.graph.disconnect();
    },
  };

  // The gateway's handler subset: annotation-assembly moved into the
  // Archivist (D2 i) and gather-summary into the Librarian — each beside
  // the actor it calls.
  registerGatewayBusHandlers(eventBus, jobQueue, project, logger);

  return {
    knowledgeSystem,
    jobQueue,
    project,
    stop: async () => {
      logger.info('Stopping gateway make-meaning');
      jobStatusSubscription.unsubscribe();
      await knowledgeSystem.stop();
      logger.info('Gateway make-meaning stopped');
    },
  };
}
