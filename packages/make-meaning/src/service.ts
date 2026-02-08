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
import { resourceId as makeResourceId } from '@semiont/core';
import { getInferenceClient, type InferenceClient } from '@semiont/inference';
import { getGraphDatabase, type GraphDatabase } from '@semiont/graph';
import { ReferenceDetectionWorker } from './jobs/reference-detection-worker';
import { GenerationWorker } from './jobs/generation-worker';
import { HighlightDetectionWorker } from './jobs/highlight-detection-worker';
import { AssessmentDetectionWorker } from './jobs/assessment-detection-worker';
import { CommentDetectionWorker } from './jobs/comment-detection-worker';
import { TagDetectionWorker } from './jobs/tag-detection-worker';
import { GraphDBConsumer } from './graph/consumer';
import { bootstrapEntityTypes } from './bootstrap/entity-types';

export interface MakeMeaningService {
  jobQueue: JobQueue;
  eventStore: EventStore;
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

export async function startMakeMeaning(config: EnvironmentConfig): Promise<MakeMeaningService> {
  console.log('🧠 Starting Make-Meaning service...');

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
  console.log('💼 Initializing job queue...');
  const jobQueue = new JobQueue({ dataDir: basePath });
  await jobQueue.initialize();
  console.log('✅ Job queue initialized');

  // 3. Create shared event store
  console.log('📊 Creating event store connection...');
  const eventStore = createEventStoreCore(basePath, baseUrl);

  // 4. Bootstrap entity types (if projection doesn't exist)
  console.log('🌱 Bootstrapping entity types...');
  await bootstrapEntityTypes(eventStore, config);
  console.log('✅ Entity types bootstrap complete');

  // 5. Create shared representation store
  console.log('📦 Creating representation store...');
  const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);
  console.log('✅ Representation store created');

  // 6. Create inference client (shared across all workers)
  console.log('🤖 Creating inference client...');
  const inferenceClient = await getInferenceClient(config);
  console.log('✅ Inference client created');

  // 7. Create graph database connection
  console.log('📊 Connecting to graph database...');
  const graphDb = await getGraphDatabase(config);
  console.log('✅ Graph database connected');

  // 8. Start graph consumer
  console.log('🔄 Starting graph consumer...');
  const graphConsumer = new GraphDBConsumer(config, eventStore, graphDb);
  await graphConsumer.initialize();

  // Subscribe to all existing resources
  const allResourceIds = await eventStore.log.getAllResourceIds();
  console.log(`[GraphDBConsumer] Subscribing to ${allResourceIds.length} resources`);
  for (const resourceId of allResourceIds) {
    await graphConsumer.subscribeToResource(makeResourceId(resourceId as string));
  }
  console.log('✅ Graph consumer started');

  // 9. Instantiate workers
  console.log('👷 Creating workers...');
  const workers = {
    detection: new ReferenceDetectionWorker(jobQueue, config, eventStore, inferenceClient),
    generation: new GenerationWorker(jobQueue, config, eventStore, inferenceClient),
    highlight: new HighlightDetectionWorker(jobQueue, config, eventStore, inferenceClient),
    assessment: new AssessmentDetectionWorker(jobQueue, config, eventStore, inferenceClient),
    comment: new CommentDetectionWorker(jobQueue, config, eventStore, inferenceClient),
    tag: new TagDetectionWorker(jobQueue, config, eventStore, inferenceClient),
  };

  // 10. Start all workers (non-blocking)
  console.log('🚀 Starting workers...');
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
  console.log('✅ All workers started');

  console.log('✅ Make-Meaning service started');

  return {
    jobQueue,
    eventStore,
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
