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
import { createKnowledgeBase } from './knowledge-base';
import { GRAPH_BARRIER_BUDGET_MS } from './graph-context';
import { Gatherer } from './gatherer';
import { Matcher } from './matcher';
import { Stower } from './stower';
import { Browser } from './browser';
import { eventAnnotationId, readAnnotationFromView } from './event-enrichment';
import { CloneTokenManager } from './clone-token-manager';
import { bootstrapEntityTypes } from './bootstrap/entity-types';
import { stopKnowledgeSystem, type KnowledgeSystem } from './knowledge-system';
import { registerBusHandlers } from './handlers';
import type { Subscription } from 'rxjs';

export type { MakeMeaningConfig } from './config';

export interface MakeMeaningService {
  knowledgeSystem: KnowledgeSystem;
  jobQueue:        JobQueue;
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

async function createKnowledgeSystemFromConfig(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  skipRebuild?: boolean,
): Promise<KnowledgeSystem> {
  const graphConfig = config.services!.graph!;
  // Each connect is announced before it is attempted: when one of them does
  // hang, the last line in the log names the culprit. Diagnosing the
  // 2026-07-20 hang took a live investigation precisely because these three
  // steps were silent.
  logger.info('Connecting to graph database', { type: graphConfig.type });
  const graphDb = await withStartupTimeout('Graph database', getGraphDatabase(graphConfig));
  const eventStore = createEventStoreCore(project, eventBus, logger.child({ component: 'event-store' }));

  // Initialize vector search if both vectors and embedding services are configured
  let vectorStore: import('@semiont/vectors').VectorStore | undefined;
  let embeddingProvider: import('@semiont/vectors').EmbeddingProvider | undefined;
  const vectorsConfig = config.services.vectors;
  const embeddingConfig = config.services.embedding;
  if (vectorsConfig && embeddingConfig) {
    const { createVectorStore, createEmbeddingProvider } = await import('@semiont/vectors');
    logger.info('Connecting to embedding provider', { type: embeddingConfig.type, model: embeddingConfig.model });
    embeddingProvider = await withStartupTimeout(
      'Embedding provider',
      createEmbeddingProvider(embeddingConfig),
    );
    logger.info('Connecting to vector store', { type: vectorsConfig.type ?? 'qdrant' });
    vectorStore = await withStartupTimeout(
      'Vector store',
      createVectorStore({
        type: vectorsConfig.type ?? 'qdrant',
        host: vectorsConfig.host,
        port: vectorsConfig.port,
        dimensions: embeddingProvider.dimensions(),
      }),
    );
    logger.info('Vector search initialized', {
      store: vectorsConfig.type,
      embedding: embeddingConfig.type,
      model: embeddingConfig.model,
    });

    // Tier 3 observability: report index point count. Polled at the
    // metric-collection interval (default 30s).
    const store = vectorStore;
    registerVectorIndexSizeProvider(() => store.count());
  }

  const kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, logger, {
    vectorStore,
    skipRebuild,
  });

  eventStore.setEnrichEvent(async (event, resourceId) => {
    const annId = eventAnnotationId(event);
    if (annId === null) return event;
    const annotation = await readAnnotationFromView(kb, resourceId, annId);
    if (annotation === null) return event;
    return { ...event, annotation } as unknown as typeof event;
  });

  const stower = new Stower(kb, eventBus, project, logger.child({ component: 'stower' }));
  await stower.initialize();

  await bootstrapEntityTypes(eventBus, eventStore, logger.child({ component: 'entity-types-bootstrap' }));

  const gatherer = new Gatherer(
    kb, eventBus,
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

  const browser = new Browser(kb.views, kb, eventBus, project, config, logger.child({ component: 'browser' }));
  await browser.initialize();

  const cloneTokenManager = new CloneTokenManager(kb, eventBus, logger.child({ component: 'clone-token-manager' }));
  await cloneTokenManager.initialize();

  const ks: KnowledgeSystem = { kb, stower, gatherer, matcher, browser, cloneTokenManager, stop: () => stopKnowledgeSystem(ks) };
  return ks;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function startMakeMeaning(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  options?: { skipRebuild?: boolean },
): Promise<MakeMeaningService> {
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
    stop: async () => {
      logger.info('Stopping Make-Meaning service');
      jobStatusSubscription.unsubscribe();
      await knowledgeSystem.stop();
      logger.info('Make-Meaning service stopped');
    },
  };
}
