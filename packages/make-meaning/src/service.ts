/**
 * Make-Meaning Service
 *
 * Consolidates all meaning-making infrastructure:
 * - Job queue initialization
 * - Worker instantiation and startup
 * - Graph consumer (event-to-graph synchronization)
 *
 * Provides a clean interface similar to createEventStore():
 *   const makeMeaning = await startMakeMeaning(config);
 */

import * as path from 'path';
import { JobQueue } from '@semiont/jobs';
import { createEventStore as createEventStoreCore, type EventStore } from '@semiont/event-sourcing';
import { getPrimaryRepresentation } from '@semiont/api-client';
import type { EnvironmentConfig, Logger, ResourceId } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { Readable } from 'stream';
import { from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { getInferenceClient, type InferenceClient } from '@semiont/inference';
import { getGraphDatabase, type GraphDatabase } from '@semiont/graph';
import {
  ReferenceAnnotationWorker,
  GenerationWorker,
  HighlightAnnotationWorker,
  AssessmentAnnotationWorker,
  CommentAnnotationWorker,
  TagAnnotationWorker,
  type ContentFetcher,
} from '@semiont/jobs';
import { GraphDBConsumer } from './graph/consumer';
import { bootstrapEntityTypes } from './bootstrap/entity-types';
import { createKnowledgeBase, type KnowledgeBase } from './knowledge-base';
import { Gatherer } from './gatherer';
import { Binder } from './binder';
import { Stower } from './stower';
import { CloneTokenManager } from './clone-token-manager';

export interface MakeMeaningService {
  kb: KnowledgeBase;
  jobQueue: JobQueue;
  eventStore: EventStore;
  inferenceClient: InferenceClient;
  graphDb: GraphDatabase;
  workers: {
    detection: ReferenceAnnotationWorker;
    generation: GenerationWorker;
    highlight: HighlightAnnotationWorker;
    assessment: AssessmentAnnotationWorker;
    comment: CommentAnnotationWorker;
    tag: TagAnnotationWorker;
  };
  graphConsumer: GraphDBConsumer;
  stower: Stower;
  gatherer: Gatherer;
  binder: Binder;
  cloneTokenManager: CloneTokenManager;
  stop: () => Promise<void>;
}

export async function startMakeMeaning(config: EnvironmentConfig, eventBus: EventBus, logger: Logger): Promise<MakeMeaningService> {
  // 1. Validate configuration
  const configuredPath = config.services?.filesystem?.path;
  if (!configuredPath) {
    throw new Error('services.filesystem.path is required for make-meaning service');
  }

  const baseUrl = config.services?.backend?.publicURL;
  if (!baseUrl) {
    throw new Error('services.backend.publicURL is required for make-meaning service');
  }

  // Resolve basePath to absolute path
  const projectRoot = config._metadata?.projectRoot;
  let basePath: string;
  if (path.isAbsolute(configuredPath)) {
    basePath = configuredPath;
  } else if (projectRoot) {
    basePath = path.resolve(projectRoot, configuredPath);
  } else {
    basePath = path.resolve(configuredPath);
  }

  // 2. Initialize job queue
  const jobQueueLogger = logger.child({ component: 'job-queue' });
  const jobQueue = new JobQueue({ dataDir: basePath }, jobQueueLogger, eventBus);
  await jobQueue.initialize();

  // 2b. Subscribe to job status queries
  const jobStatusSubscription = eventBus.get('job:status-requested').pipe(
    mergeMap((event) => from((async () => {
      try {
        const job = await jobQueue.getJob(event.jobId);
        if (!job) {
          eventBus.get('job:status-failed').next({
            correlationId: event.correlationId,
            error: new Error('Job not found'),
          });
          return;
        }
        eventBus.get('job:status-result').next({
          correlationId: event.correlationId,
          response: {
            jobId: job.metadata.id,
            type: job.metadata.type,
            status: job.status,
            userId: job.metadata.userId,
            created: job.metadata.created,
            startedAt: job.status === 'running' || job.status === 'complete' ? job.startedAt : undefined,
            completedAt: job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled' ? job.completedAt : undefined,
            error: job.status === 'failed' ? job.error : undefined,
            progress: job.status === 'running' ? job.progress : undefined,
            result: job.status === 'complete' ? job.result : undefined,
          },
        });
      } catch (error) {
        eventBus.get('job:status-failed').next({
          correlationId: event.correlationId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    })())),
  ).subscribe({
    error: (err) => jobQueueLogger.error('Job status pipeline error', { error: err }),
  });

  // 3. Create shared event store with EventBus integration
  const eventStoreLogger = logger.child({ component: 'event-store' });
  const eventStore = createEventStoreCore(basePath, baseUrl, undefined, eventBus, eventStoreLogger);

  // 4. Create inference client (shared across all workers)
  const inferenceLogger = logger.child({ component: 'inference-client' });
  const inferenceClient = await getInferenceClient(config, inferenceLogger);

  // 6. Create graph database connection
  const graphDb = await getGraphDatabase(config);

  // 7. Create Knowledge Base (groups event store, views, content store, graph)
  const kb = createKnowledgeBase(eventStore, basePath, projectRoot, graphDb, logger);

  // 8. Start graph consumer
  const graphConsumerLogger = logger.child({ component: 'graph-consumer' });
  const graphConsumer = new GraphDBConsumer(config, eventStore, graphDb, graphConsumerLogger);
  await graphConsumer.initialize();

  // 9. Start Stower actor (write gateway — must start before Gatherer/Binder)
  const stowerLogger = logger.child({ component: 'stower' });
  const stower = new Stower(kb, baseUrl, eventBus, stowerLogger);
  await stower.initialize();

  // 9b. Bootstrap entity types (requires Stower to be running, emits via EventBus)
  const bootstrapLogger = logger.child({ component: 'entity-types-bootstrap' });
  await bootstrapEntityTypes(eventBus, config, bootstrapLogger);

  // 10. Start Gatherer actor
  const gathererLogger = logger.child({ component: 'gatherer' });
  const gatherer = new Gatherer(baseUrl, kb, eventBus, inferenceClient, gathererLogger, config);
  await gatherer.initialize();

  // 10. Start Binder actor
  const binderLogger = logger.child({ component: 'binder' });
  const binder = new Binder(kb, eventBus, binderLogger, baseUrl);
  await binder.initialize();

  // 10b. Start CloneTokenManager actor
  const cloneTokenLogger = logger.child({ component: 'clone-token-manager' });
  const cloneTokenManager = new CloneTokenManager(kb, eventBus, cloneTokenLogger);
  await cloneTokenManager.initialize();

  // 11. Create ContentFetcher backed by KB views + content store
  const contentFetcher: ContentFetcher = async (resourceId: ResourceId): Promise<Readable | null> => {
    const view = await kb.views.get(resourceId);
    if (!view) return null;
    const primaryRep = getPrimaryRepresentation(view.resource);
    if (!primaryRep?.checksum || !primaryRep?.mediaType) return null;
    const buffer = await kb.content.retrieve(primaryRep.checksum, primaryRep.mediaType);
    if (!buffer) return null;
    return Readable.from([buffer]);
  };

  // 12. Create child loggers for workers
  const detectionLogger = logger.child({ component: 'reference-detection-worker' });
  const generationLogger = logger.child({ component: 'generation-worker' });
  const highlightLogger = logger.child({ component: 'highlight-detection-worker' });
  const assessmentLogger = logger.child({ component: 'assessment-detection-worker' });
  const commentLogger = logger.child({ component: 'comment-detection-worker' });
  const tagLogger = logger.child({ component: 'tag-detection-worker' });

  // 13. Instantiate workers with EventBus, ContentFetcher, and logger
  const workers = {
    detection: new ReferenceAnnotationWorker(jobQueue, config, inferenceClient, eventBus, contentFetcher, detectionLogger),
    generation: new GenerationWorker(jobQueue, config, inferenceClient, eventBus, generationLogger),
    highlight: new HighlightAnnotationWorker(jobQueue, config, inferenceClient, eventBus, contentFetcher, highlightLogger),
    assessment: new AssessmentAnnotationWorker(jobQueue, config, inferenceClient, eventBus, contentFetcher, assessmentLogger),
    comment: new CommentAnnotationWorker(jobQueue, config, inferenceClient, eventBus, contentFetcher, commentLogger),
    tag: new TagAnnotationWorker(jobQueue, config, inferenceClient, eventBus, contentFetcher, tagLogger),
  };

  // 11. Start all workers (non-blocking)
  workers.detection.start().catch((error: unknown) => {
    detectionLogger.error('Worker stopped unexpectedly', { error });
  });
  workers.generation.start().catch((error: unknown) => {
    generationLogger.error('Worker stopped unexpectedly', { error });
  });
  workers.highlight.start().catch((error: unknown) => {
    highlightLogger.error('Worker stopped unexpectedly', { error });
  });
  workers.assessment.start().catch((error: unknown) => {
    assessmentLogger.error('Worker stopped unexpectedly', { error });
  });
  workers.comment.start().catch((error: unknown) => {
    commentLogger.error('Worker stopped unexpectedly', { error });
  });
  workers.tag.start().catch((error: unknown) => {
    tagLogger.error('Worker stopped unexpectedly', { error });
  });

  return {
    kb,
    jobQueue,
    eventStore,
    inferenceClient,
    graphDb,
    workers,
    graphConsumer,
    stower,
    gatherer,
    binder,
    cloneTokenManager,
    stop: async () => {
      logger.info('Stopping Make-Meaning service');
      await Promise.all([
        workers.detection.stop(),
        workers.generation.stop(),
        workers.highlight.stop(),
        workers.assessment.stop(),
        workers.comment.stop(),
        workers.tag.stop(),
      ]);
      await gatherer.stop();
      await binder.stop();
      jobStatusSubscription.unsubscribe();
      await cloneTokenManager.stop();
      await stower.stop();
      await graphConsumer.stop();
      await graphDb.disconnect();
      logger.info('Make-Meaning service stopped');
    },
  };
}
