/**
 * Make-Meaning Service
 *
 * Consolidates all meaning-making infrastructure:
 * - Job queue initialization
 * - Worker instantiation and startup
 *
 * Provides a clean interface similar to createEventStore():
 *   const makeMeaning = await startMakeMeaning(config);
 */

import { JobQueue } from '@semiont/jobs';
import { createEventStore as createEventStoreCore } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger, type ResourceId } from '@semiont/core';
import { resolveActorInference, resolveWorkerInference, type MakeMeaningConfig } from './config';
import { inferenceConfigToGenerator } from './agent-utils';

export type { MakeMeaningConfig } from './config';

import { Readable } from 'stream';
import { from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { createInferenceClient } from '@semiont/inference';
import { getGraphDatabase } from '@semiont/graph';
import {
  ReferenceAnnotationWorker,
  GenerationWorker,
  HighlightAnnotationWorker,
  AssessmentAnnotationWorker,
  CommentAnnotationWorker,
  TagAnnotationWorker,
  type ContentFetcher,
} from '@semiont/jobs';
import { createKnowledgeBase } from './knowledge-base';
import { Gatherer } from './gatherer';
import { Matcher } from './matcher';
import { Stower } from './stower';
import { CloneTokenManager } from './clone-token-manager';
import { bootstrapEntityTypes } from './bootstrap/entity-types';
import type { KnowledgeSystem } from './knowledge-system';

export interface MakeMeaningService {
  knowledgeSystem: KnowledgeSystem;
  jobQueue: JobQueue;
  workers: {
    detection:  ReferenceAnnotationWorker;
    generation: GenerationWorker;
    highlight:  HighlightAnnotationWorker;
    assessment: AssessmentAnnotationWorker;
    comment:    CommentAnnotationWorker;
    tag:        TagAnnotationWorker;
  };
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
  const jobQueue = new JobQueue(project, jobQueueLogger, eventBus);
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
  const eventStore = createEventStoreCore(project, eventBus, eventStoreLogger);

  // 4. Create per-actor inference clients
  const gathererInferenceClient = createInferenceClient(
    resolveActorInference(config, 'gatherer'),
    logger.child({ component: 'inference-client-gatherer' })
  );
  const matcherInferenceClient = createInferenceClient(
    resolveActorInference(config, 'matcher'),
    logger.child({ component: 'inference-client-matcher' })
  );

  // 5. Create per-worker inference clients and generator Agents
  const detectionInferenceCfg = resolveWorkerInference(config, 'reference-annotation');
  const detectionInferenceClient = createInferenceClient(detectionInferenceCfg, logger.child({ component: 'inference-client-reference-annotation' }));
  const detectionGenerator = inferenceConfigToGenerator('Reference Worker', detectionInferenceCfg);

  const generationInferenceClient = createInferenceClient(
    resolveWorkerInference(config, 'generation'),
    logger.child({ component: 'inference-client-generation' })
  );

  const highlightInferenceCfg = resolveWorkerInference(config, 'highlight-annotation');
  const highlightInferenceClient = createInferenceClient(highlightInferenceCfg, logger.child({ component: 'inference-client-highlight-annotation' }));
  const highlightGenerator = inferenceConfigToGenerator('Highlight Worker', highlightInferenceCfg);

  const assessmentInferenceCfg = resolveWorkerInference(config, 'assessment-annotation');
  const assessmentInferenceClient = createInferenceClient(assessmentInferenceCfg, logger.child({ component: 'inference-client-assessment-annotation' }));
  const assessmentGenerator = inferenceConfigToGenerator('Assessment Worker', assessmentInferenceCfg);

  const commentInferenceCfg = resolveWorkerInference(config, 'comment-annotation');
  const commentInferenceClient = createInferenceClient(commentInferenceCfg, logger.child({ component: 'inference-client-comment-annotation' }));
  const commentGenerator = inferenceConfigToGenerator('Comment Worker', commentInferenceCfg);

  const tagInferenceCfg = resolveWorkerInference(config, 'tag-annotation');
  const tagInferenceClient = createInferenceClient(tagInferenceCfg, logger.child({ component: 'inference-client-tag-annotation' }));
  const tagGenerator = inferenceConfigToGenerator('Tag Worker', tagInferenceCfg);

  // 6. Create graph database connection
  const graphDb = await getGraphDatabase(graphConfig);

  // 7. Create Knowledge Base (event store, views, content store, graph, graph consumer)
  const kb = await createKnowledgeBase(eventStore, project, graphDb, logger);

  // 8. Start Stower actor (write gateway — must start before Gatherer/Matcher)
  const stowerLogger = logger.child({ component: 'stower' });
  const stower = new Stower(kb, eventBus, stowerLogger);
  await stower.initialize();

  // 8b. Bootstrap entity types (requires Stower to be running, emits via EventBus)
  const bootstrapLogger = logger.child({ component: 'entity-types-bootstrap' });
  await bootstrapEntityTypes(eventBus, project, bootstrapLogger);

  // 9. Start Gatherer actor
  const gathererLogger = logger.child({ component: 'gatherer' });
  const gatherer = new Gatherer(kb, eventBus, gathererInferenceClient, gathererLogger, project);
  await gatherer.initialize();

  // 10. Start Matcher actor
  const matcherLogger = logger.child({ component: 'matcher' });
  const matcher = new Matcher(kb, eventBus, matcherLogger, matcherInferenceClient);
  await matcher.initialize();

  // 11. Start CloneTokenManager actor
  const cloneTokenLogger = logger.child({ component: 'clone-token-manager' });
  const cloneTokenManager = new CloneTokenManager(kb, eventBus, cloneTokenLogger);
  await cloneTokenManager.initialize();

  // 12. Assemble KnowledgeSystem
  const knowledgeSystem: KnowledgeSystem = { kb, stower, gatherer, matcher, cloneTokenManager };

  // 13. Create ContentFetcher backed by KB views + content store
  const contentFetcher: ContentFetcher = async (resourceId: ResourceId): Promise<Readable | null> => {
    const view = await kb.views.get(resourceId);
    if (!view?.resource.storageUri) return null;
    const buffer = await kb.content.retrieve(view.resource.storageUri);
    if (!buffer) return null;
    return Readable.from([buffer]);
  };

  // 14. Create child loggers for workers
  const detectionLogger = logger.child({ component: 'reference-detection-worker' });
  const generationLogger = logger.child({ component: 'generation-worker' });
  const highlightLogger = logger.child({ component: 'highlight-detection-worker' });
  const assessmentLogger = logger.child({ component: 'assessment-detection-worker' });
  const commentLogger = logger.child({ component: 'comment-detection-worker' });
  const tagLogger = logger.child({ component: 'tag-detection-worker' });

  // 15. Instantiate workers with per-worker inference clients
  const workers = {
    detection:  new ReferenceAnnotationWorker(jobQueue, detectionInferenceClient, detectionGenerator, eventBus, contentFetcher, detectionLogger),
    generation: new GenerationWorker(jobQueue, generationInferenceClient, eventBus, generationLogger),
    highlight:  new HighlightAnnotationWorker(jobQueue, highlightInferenceClient, highlightGenerator, eventBus, contentFetcher, highlightLogger),
    assessment: new AssessmentAnnotationWorker(jobQueue, assessmentInferenceClient, assessmentGenerator, eventBus, contentFetcher, assessmentLogger),
    comment:    new CommentAnnotationWorker(jobQueue, commentInferenceClient, commentGenerator, eventBus, contentFetcher, commentLogger),
    tag:        new TagAnnotationWorker(jobQueue, tagInferenceClient, tagGenerator, eventBus, contentFetcher, tagLogger),
  };

  // 16. Start all workers (non-blocking)
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
    knowledgeSystem,
    jobQueue,
    workers,
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
      await kb.graphConsumer.stop();
      await graphDb.disconnect();
      logger.info('Make-Meaning service stopped');
    },
  };
}
