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

import { JobQueue } from '@semiont/jobs';
import { createEventStore as createEventStoreCore, type EventStore } from '@semiont/event-sourcing';
import { getPrimaryRepresentation } from '@semiont/api-client';
import type { Logger, ResourceId } from '@semiont/core';
import { EventBus, SemiontProject } from '@semiont/core';
import { resolveActorInference, resolveWorkerInference, type MakeMeaningConfig } from './config';

export type { MakeMeaningConfig } from './config';

import { Readable } from 'stream';
import { from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { createInferenceClient, type InferenceClient } from '@semiont/inference';
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
import { Matcher } from './matcher';
import { Stower } from './stower';
import { CloneTokenManager } from './clone-token-manager';

export interface MakeMeaningService {
  kb: KnowledgeBase;
  jobQueue: JobQueue;
  eventStore: EventStore;
  graphDb: GraphDatabase;
  /** Inference client for the Gatherer actor — use for context-assembly operations */
  gathererInferenceClient: InferenceClient;
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
  matcher: Matcher;
  cloneTokenManager: CloneTokenManager;
  stop: () => Promise<void>;
}

export async function startMakeMeaning(project: SemiontProject, config: MakeMeaningConfig, eventBus: EventBus, logger: Logger): Promise<MakeMeaningService> {
  // 1. Validate configuration
  const graphConfig = config.services?.graph;
  if (!graphConfig) {
    throw new Error('services.graph is required for make-meaning service');
  }

  // 2. Initialize job queue
  const jobQueueLogger = logger.child({ component: 'job-queue' });
  const jobQueue = new JobQueue({ dataDir: project.stateDir }, jobQueueLogger, eventBus);
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
  const eventStore = createEventStoreCore(project, undefined, eventBus, eventStoreLogger);

  // 4. Create per-actor inference clients
  const gathererInferenceClient = createInferenceClient(
    resolveActorInference(config, 'gatherer'),
    logger.child({ component: 'inference-client-gatherer' })
  );
  const matcherInferenceClient = createInferenceClient(
    resolveActorInference(config, 'matcher'),
    logger.child({ component: 'inference-client-matcher' })
  );

  // 5. Create per-worker inference clients
  const detectionInferenceClient = createInferenceClient(
    resolveWorkerInference(config, 'reference-annotation'),
    logger.child({ component: 'inference-client-reference-annotation' })
  );
  const generationInferenceClient = createInferenceClient(
    resolveWorkerInference(config, 'generation'),
    logger.child({ component: 'inference-client-generation' })
  );
  const highlightInferenceClient = createInferenceClient(
    resolveWorkerInference(config, 'highlight-annotation'),
    logger.child({ component: 'inference-client-highlight-annotation' })
  );
  const assessmentInferenceClient = createInferenceClient(
    resolveWorkerInference(config, 'assessment-annotation'),
    logger.child({ component: 'inference-client-assessment-annotation' })
  );
  const commentInferenceClient = createInferenceClient(
    resolveWorkerInference(config, 'comment-annotation'),
    logger.child({ component: 'inference-client-comment-annotation' })
  );
  const tagInferenceClient = createInferenceClient(
    resolveWorkerInference(config, 'tag-annotation'),
    logger.child({ component: 'inference-client-tag-annotation' })
  );

  // 6. Create graph database connection
  const graphDb = await getGraphDatabase(graphConfig);

  // 7. Create Knowledge Base (groups event store, views, content store, graph)
  const kb = createKnowledgeBase(eventStore, project, graphDb, logger);

  // 8. Start graph consumer
  const graphConsumerLogger = logger.child({ component: 'graph-consumer' });
  const graphConsumer = new GraphDBConsumer(eventStore, graphDb, graphConsumerLogger);
  await graphConsumer.initialize();

  // 9. Start Stower actor (write gateway — must start before Gatherer/Matcher)
  const stowerLogger = logger.child({ component: 'stower' });
  const stower = new Stower(kb, eventBus, stowerLogger);
  await stower.initialize();

  // 9b. Bootstrap entity types (requires Stower to be running, emits via EventBus)
  const bootstrapLogger = logger.child({ component: 'entity-types-bootstrap' });
  await bootstrapEntityTypes(eventBus, project, bootstrapLogger);

  // 10. Start Gatherer actor
  const gathererLogger = logger.child({ component: 'gatherer' });
  const gatherer = new Gatherer(kb, eventBus, gathererInferenceClient, gathererLogger, project);
  await gatherer.initialize();

  // 10. Start Matcher actor
  const matcherLogger = logger.child({ component: 'matcher' });
  const matcher = new Matcher(kb, eventBus, matcherLogger, matcherInferenceClient);
  await matcher.initialize();

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

  // 13. Instantiate workers with per-worker inference clients
  const workers = {
    detection: new ReferenceAnnotationWorker(jobQueue, detectionInferenceClient, eventBus, contentFetcher, detectionLogger),
    generation: new GenerationWorker(jobQueue, generationInferenceClient, eventBus, generationLogger),
    highlight: new HighlightAnnotationWorker(jobQueue, highlightInferenceClient, eventBus, contentFetcher, highlightLogger),
    assessment: new AssessmentAnnotationWorker(jobQueue, assessmentInferenceClient, eventBus, contentFetcher, assessmentLogger),
    comment: new CommentAnnotationWorker(jobQueue, commentInferenceClient, eventBus, contentFetcher, commentLogger),
    tag: new TagAnnotationWorker(jobQueue, tagInferenceClient, eventBus, contentFetcher, tagLogger),
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
    graphDb,
    gathererInferenceClient,
    workers,
    graphConsumer,
    stower,
    gatherer,
    matcher,
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
      await matcher.stop();
      jobStatusSubscription.unsubscribe();
      await cloneTokenManager.stop();
      await stower.stop();
      await graphConsumer.stop();
      await graphDb.disconnect();
      logger.info('Make-Meaning service stopped');
    },
  };
}
