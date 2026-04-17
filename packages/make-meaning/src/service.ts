/**
 * Make-Meaning Service
 *
 * Provides a clean interface:
 *   const makeMeaning = await startMakeMeaning(project, config, eventBus, logger);
 */

import { FsJobQueue, type JobQueue } from '@semiont/jobs';
import { createEventStore as createEventStoreCore } from '@semiont/event-sourcing';
import type { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger, jobId } from '@semiont/core';
import { resolveActorInference, type MakeMeaningConfig } from './config';
import { from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { createInferenceClient } from '@semiont/inference';
import { getGraphDatabase } from '@semiont/graph';
import type {
  ReferenceAnnotationWorker,
  GenerationWorker,
  HighlightAnnotationWorker,
  AssessmentAnnotationWorker,
  CommentAnnotationWorker,
  TagAnnotationWorker,
} from '@semiont/jobs';
import { createKnowledgeBase } from './knowledge-base';
import { Gatherer } from './gatherer';
import { Matcher } from './matcher';
import { Stower } from './stower';
import { Browser } from './browser';
import { CloneTokenManager } from './clone-token-manager';
import { bootstrapEntityTypes } from './bootstrap/entity-types';
import { stopKnowledgeSystem, type KnowledgeSystem } from './knowledge-system';
import type { Subscription } from 'rxjs';

export type { MakeMeaningConfig } from './config';

export interface MakeMeaningService {
  knowledgeSystem: KnowledgeSystem;
  jobQueue:        JobQueue;
  workers:         Workers;
  stop:            () => Promise<void>;
}

type Workers = {
  detection:  ReferenceAnnotationWorker;
  generation: GenerationWorker;
  highlight:  HighlightAnnotationWorker;
  assessment: AssessmentAnnotationWorker;
  comment:    CommentAnnotationWorker;
  tag:        TagAnnotationWorker;
};

// ─── Step helpers ─────────────────────────────────────────────────────────────

async function createJobQueue(
  project: SemiontProject,
  eventBus: EventBus,
  logger: Logger,
): Promise<{ jobQueue: JobQueue; jobStatusSubscription: Subscription }> {
  const jobQueueLogger = logger.child({ component: 'job-queue' });
  const jobQueue = new FsJobQueue(project, jobQueueLogger, eventBus);
  await jobQueue.initialize();

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

async function createKnowledgeSystemFromConfig(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  skipRebuild?: boolean,
): Promise<KnowledgeSystem> {
  const graphConfig = config.services!.graph!;
  const graphDb   = await getGraphDatabase(graphConfig);
  const eventStore = createEventStoreCore(project, eventBus, logger.child({ component: 'event-store' }));

  // Initialize vector search if both vectors and embedding services are configured
  let vectorStore: import('@semiont/vectors').VectorStore | undefined;
  let embeddingProvider: import('@semiont/vectors').EmbeddingProvider | undefined;
  const vectorsConfig = config.services.vectors;
  const embeddingConfig = config.services.embedding;
  if (vectorsConfig && embeddingConfig) {
    const { createVectorStore, createEmbeddingProvider } = await import('@semiont/vectors');
    embeddingProvider = await createEmbeddingProvider(embeddingConfig);
    vectorStore = await createVectorStore({
      type: vectorsConfig.type ?? 'qdrant',
      host: vectorsConfig.host,
      port: vectorsConfig.port,
      dimensions: embeddingProvider.dimensions(),
    });
    logger.info('Vector search initialized', {
      store: vectorsConfig.type,
      embedding: embeddingConfig.type,
      model: embeddingConfig.model,
    });
  }

  const kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, logger, {
    vectorStore,
    skipRebuild,
  });

  const stower = new Stower(kb, eventBus, logger.child({ component: 'stower' }));
  await stower.initialize();

  await bootstrapEntityTypes(eventBus, eventStore, logger.child({ component: 'entity-types-bootstrap' }));

  const gatherer = new Gatherer(
    kb, eventBus,
    createInferenceClient(resolveActorInference(config, 'gatherer'), logger.child({ component: 'inference-client-gatherer' })),
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

  const browser = new Browser(kb.views, kb, eventBus, project, logger.child({ component: 'browser' }));
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

  const skipRebuild = options?.skipRebuild ?? (process.env.SEMIONT_SKIP_REBUILD === 'true');

  const { jobQueue, jobStatusSubscription } = await createJobQueue(project, eventBus, logger);
  const knowledgeSystem = await createKnowledgeSystemFromConfig(project, config, eventBus, logger, skipRebuild);

  return {
    knowledgeSystem,
    jobQueue,
    workers: {} as Workers,
    stop: async () => {
      logger.info('Stopping Make-Meaning service');
      jobStatusSubscription.unsubscribe();
      await knowledgeSystem.stop();
      logger.info('Make-Meaning service stopped');
    },
  };
}
