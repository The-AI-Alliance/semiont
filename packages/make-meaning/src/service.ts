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
import type { EnvironmentConfig } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { getInferenceClient, type InferenceClient } from '@semiont/inference';
import { getGraphDatabase, type GraphDatabase } from '@semiont/graph';
import { ReferenceDetectionWorker } from './jobs/reference-annotation-worker';
import { GenerationWorker } from './jobs/generation-worker';
import { HighlightDetectionWorker } from './jobs/highlight-annotation-worker';
import { AssessmentDetectionWorker } from './jobs/assessment-annotation-worker';
import { CommentDetectionWorker } from './jobs/comment-annotation-worker';
import { TagDetectionWorker } from './jobs/tag-annotation-worker';
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
    detection: ReferenceDetectionWorker;
    generation: GenerationWorker;
    highlight: HighlightDetectionWorker;
    assessment: AssessmentDetectionWorker;
    comment: CommentDetectionWorker;
    tag: TagDetectionWorker;
  };
  graphConsumer: GraphDBConsumer;
  stop: () => Promise<void>;
}

export async function startMakeMeaning(config: EnvironmentConfig, eventBus: EventBus): Promise<MakeMeaningService> {
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
  const jobQueue = new JobQueue({ dataDir: basePath }, eventBus);
  await jobQueue.initialize();

  // 3. Create shared event store with EventBus integration
  const eventStore = createEventStoreCore(basePath, baseUrl, undefined, eventBus);

  // 4. Bootstrap entity types (if projection doesn't exist)
  await bootstrapEntityTypes(eventStore, config);

  // 5. Create shared representation store
  const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

  // 6. Create inference client (shared across all workers)
  const inferenceClient = await getInferenceClient(config);

  // 7. Create graph database connection
  const graphDb = await getGraphDatabase(config);

  // 8. Start graph consumer
  const graphConsumer = new GraphDBConsumer(config, eventStore, graphDb);
  await graphConsumer.initialize();

  // 9. Instantiate workers with EventBus
  const workers = {
    detection: new ReferenceDetectionWorker(jobQueue, config, eventStore, inferenceClient, eventBus),
    generation: new GenerationWorker(jobQueue, config, eventStore, inferenceClient, eventBus),
    highlight: new HighlightDetectionWorker(jobQueue, config, eventStore, inferenceClient, eventBus),
    assessment: new AssessmentDetectionWorker(jobQueue, config, eventStore, inferenceClient, eventBus),
    comment: new CommentDetectionWorker(jobQueue, config, eventStore, inferenceClient, eventBus),
    tag: new TagDetectionWorker(jobQueue, config, eventStore, inferenceClient, eventBus),
  };

  // 10. Start all workers (non-blocking)
  workers.detection.start().catch((error: unknown) => {
    console.error('⚠️ Detection worker stopped:', error);
  });
  workers.generation.start().catch((error: unknown) => {
    console.error('⚠️ Generation worker stopped:', error);
  });
  workers.highlight.start().catch((error: unknown) => {
    console.error('⚠️ Highlight worker stopped:', error);
  });
  workers.assessment.start().catch((error: unknown) => {
    console.error('⚠️ Assessment worker stopped:', error);
  });
  workers.comment.start().catch((error: unknown) => {
    console.error('⚠️ Comment worker stopped:', error);
  });
  workers.tag.start().catch((error: unknown) => {
    console.error('⚠️ Tag worker stopped:', error);
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
      console.log('⏹️ Stopping Make-Meaning service...');
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
      console.log('✅ Make-Meaning service stopped');
    },
  };
}
