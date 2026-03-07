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
import { FilesystemRepresentationStore, type RepresentationStore } from '@semiont/content';
import type { EnvironmentConfig, Logger } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { getInferenceClient, type InferenceClient } from '@semiont/inference';
import { getGraphDatabase, type GraphDatabase } from '@semiont/graph';
import { ReferenceAnnotationWorker } from './jobs/reference-annotation-worker';
import { GenerationWorker } from './jobs/generation-worker';
import { HighlightAnnotationWorker } from './jobs/highlight-annotation-worker';
import { AssessmentAnnotationWorker } from './jobs/assessment-annotation-worker';
import { CommentAnnotationWorker } from './jobs/comment-annotation-worker';
import { TagAnnotationWorker } from './jobs/tag-annotation-worker';
import { GraphDBConsumer } from './graph/consumer';
import { bootstrapEntityTypes } from './bootstrap/entity-types';

export interface MakeMeaningService {
  jobQueue: JobQueue;
  eventStore: EventStore;
  eventBus: EventBus;
  repStore: RepresentationStore;
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

  // 3. Create shared event store with EventBus integration
  const eventStoreLogger = logger.child({ component: 'event-store' });
  const eventStore = createEventStoreCore(basePath, baseUrl, undefined, eventBus, eventStoreLogger);

  // 4. Bootstrap entity types (if projection doesn't exist)
  const bootstrapLogger = logger.child({ component: 'entity-types-bootstrap' });
  await bootstrapEntityTypes(eventStore, config, bootstrapLogger);

  // 5. Create shared representation store
  const repStoreLogger = logger.child({ component: 'representation-store' });
  const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot, repStoreLogger);

  // 6. Create inference client (shared across all workers)
  const inferenceLogger = logger.child({ component: 'inference-client' });
  const inferenceClient = await getInferenceClient(config, inferenceLogger);

  // 7. Create graph database connection
  const graphDb = await getGraphDatabase(config);

  // 8. Create child loggers for each component
  const detectionLogger = logger.child({ component: 'reference-detection-worker' });
  const generationLogger = logger.child({ component: 'generation-worker' });
  const highlightLogger = logger.child({ component: 'highlight-detection-worker' });
  const assessmentLogger = logger.child({ component: 'assessment-detection-worker' });
  const commentLogger = logger.child({ component: 'comment-detection-worker' });
  const tagLogger = logger.child({ component: 'tag-detection-worker' });
  const graphConsumerLogger = logger.child({ component: 'graph-consumer' });

  // 9. Start graph consumer
  const graphConsumer = new GraphDBConsumer(config, eventStore, graphDb, graphConsumerLogger);
  await graphConsumer.initialize();

  // 10. Instantiate workers with EventBus and logger
  const workers = {
    detection: new ReferenceAnnotationWorker(jobQueue, config, eventStore, inferenceClient, eventBus, detectionLogger),
    generation: new GenerationWorker(jobQueue, config, eventStore, inferenceClient, eventBus, generationLogger),
    highlight: new HighlightAnnotationWorker(jobQueue, config, eventStore, inferenceClient, eventBus, highlightLogger),
    assessment: new AssessmentAnnotationWorker(jobQueue, config, eventStore, inferenceClient, eventBus, assessmentLogger),
    comment: new CommentAnnotationWorker(jobQueue, config, eventStore, inferenceClient, eventBus, commentLogger),
    tag: new TagAnnotationWorker(jobQueue, config, eventStore, inferenceClient, eventBus, tagLogger),
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
    jobQueue,
    eventStore,
    eventBus,
    repStore,
    inferenceClient,
    graphDb,
    workers,
    graphConsumer,
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
      await graphConsumer.stop();
      await graphDb.disconnect();
      logger.info('Make-Meaning service stopped');
    },
  };
}
