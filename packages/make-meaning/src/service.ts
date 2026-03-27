/**
 * Make-Meaning Service
 *
 * Provides a clean interface:
 *   const makeMeaning = await startMakeMeaning(project, config, eventBus, logger);
 */

import { JobQueue } from '@semiont/jobs';
import { createEventStore as createEventStoreCore } from '@semiont/event-sourcing';
import type { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger, type ResourceId } from '@semiont/core';
import { resolveActorInference, resolveWorkerInference, type MakeMeaningConfig } from './config';
import { inferenceConfigToGenerator } from './agent-utils';
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
  const jobQueue = new JobQueue(project, jobQueueLogger, eventBus);
  await jobQueue.initialize();

  const jobStatusSubscription = eventBus.get('job:status-requested').pipe(
    mergeMap((event) => from((async () => {
      try {
        const job = await jobQueue.getJob(event.jobId);
        if (!job) {
          eventBus.get('job:status-failed').next({ correlationId: event.correlationId, error: new Error('Job not found') });
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
          error: error instanceof Error ? error : new Error(String(error)),
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
): Promise<KnowledgeSystem> {
  const graphConfig = config.services!.graph!;
  const graphDb   = await getGraphDatabase(graphConfig);
  const eventStore = createEventStoreCore(project, eventBus, logger.child({ component: 'event-store' }));
  const kb         = await createKnowledgeBase(eventStore, project, graphDb, logger);

  const stower = new Stower(kb, eventBus, logger.child({ component: 'stower' }));
  await stower.initialize();

  await bootstrapEntityTypes(eventBus, project, logger.child({ component: 'entity-types-bootstrap' }));

  const gatherer = new Gatherer(
    kb, eventBus,
    createInferenceClient(resolveActorInference(config, 'gatherer'), logger.child({ component: 'inference-client-gatherer' })),
    logger.child({ component: 'gatherer' }),
    project,
  );
  await gatherer.initialize();

  const matcher = new Matcher(
    kb, eventBus,
    logger.child({ component: 'matcher' }),
    createInferenceClient(resolveActorInference(config, 'matcher'), logger.child({ component: 'inference-client-matcher' })),
  );
  await matcher.initialize();

  const cloneTokenManager = new CloneTokenManager(kb, eventBus, logger.child({ component: 'clone-token-manager' }));
  await cloneTokenManager.initialize();

  const ks: KnowledgeSystem = { kb, stower, gatherer, matcher, cloneTokenManager, stop: () => stopKnowledgeSystem(ks) };
  return ks;
}

function createContentFetcher(ks: KnowledgeSystem): ContentFetcher {
  return async (resourceId: ResourceId): Promise<Readable | null> => {
    const view = await ks.kb.views.get(resourceId);
    if (!view?.resource.storageUri) return null;
    const buffer = await ks.kb.content.retrieve(view.resource.storageUri);
    if (!buffer) return null;
    return Readable.from([buffer]);
  };
}

function createWorkers(
  jobQueue: JobQueue,
  contentFetcher: ContentFetcher,
  eventBus: EventBus,
  config: MakeMeaningConfig,
  logger: Logger,
): Workers {
  const detection = (() => {
    const cfg = resolveWorkerInference(config, 'reference-annotation');
    return new ReferenceAnnotationWorker(jobQueue, createInferenceClient(cfg, logger.child({ component: 'inference-client-reference-annotation' })), inferenceConfigToGenerator('Reference Worker', cfg), eventBus, contentFetcher, logger.child({ component: 'reference-detection-worker' }));
  })();

  const generation = new GenerationWorker(
    jobQueue,
    createInferenceClient(resolveWorkerInference(config, 'generation'), logger.child({ component: 'inference-client-generation' })),
    eventBus,
    logger.child({ component: 'generation-worker' }),
  );

  const highlight = (() => {
    const cfg = resolveWorkerInference(config, 'highlight-annotation');
    return new HighlightAnnotationWorker(jobQueue, createInferenceClient(cfg, logger.child({ component: 'inference-client-highlight-annotation' })), inferenceConfigToGenerator('Highlight Worker', cfg), eventBus, contentFetcher, logger.child({ component: 'highlight-detection-worker' }));
  })();

  const assessment = (() => {
    const cfg = resolveWorkerInference(config, 'assessment-annotation');
    return new AssessmentAnnotationWorker(jobQueue, createInferenceClient(cfg, logger.child({ component: 'inference-client-assessment-annotation' })), inferenceConfigToGenerator('Assessment Worker', cfg), eventBus, contentFetcher, logger.child({ component: 'assessment-detection-worker' }));
  })();

  const comment = (() => {
    const cfg = resolveWorkerInference(config, 'comment-annotation');
    return new CommentAnnotationWorker(jobQueue, createInferenceClient(cfg, logger.child({ component: 'inference-client-comment-annotation' })), inferenceConfigToGenerator('Comment Worker', cfg), eventBus, contentFetcher, logger.child({ component: 'comment-detection-worker' }));
  })();

  const tag = (() => {
    const cfg = resolveWorkerInference(config, 'tag-annotation');
    return new TagAnnotationWorker(jobQueue, createInferenceClient(cfg, logger.child({ component: 'inference-client-tag-annotation' })), inferenceConfigToGenerator('Tag Worker', cfg), eventBus, contentFetcher, logger.child({ component: 'tag-detection-worker' }));
  })();

  return { detection, generation, highlight, assessment, comment, tag };
}

function startWorkers(workers: Workers, logger: Logger): void {
  const entries: [keyof Workers, string][] = [
    ['detection',  'reference-detection-worker'],
    ['generation', 'generation-worker'],
    ['highlight',  'highlight-detection-worker'],
    ['assessment', 'assessment-detection-worker'],
    ['comment',    'comment-detection-worker'],
    ['tag',        'tag-detection-worker'],
  ];
  for (const [key, component] of entries) {
    workers[key].start().catch((error: unknown) => {
      logger.child({ component }).error('Worker stopped unexpectedly', { error });
    });
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function startMakeMeaning(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
): Promise<MakeMeaningService> {
  if (!config.services?.graph) {
    throw new Error('services.graph is required for make-meaning service');
  }

  const { jobQueue, jobStatusSubscription } = await createJobQueue(project, eventBus, logger);
  const knowledgeSystem = await createKnowledgeSystemFromConfig(project, config, eventBus, logger);
  const contentFetcher  = createContentFetcher(knowledgeSystem);
  const workers         = createWorkers(jobQueue, contentFetcher, eventBus, config, logger);
  startWorkers(workers, logger);

  return {
    knowledgeSystem,
    jobQueue,
    workers,
    stop: async () => {
      logger.info('Stopping Make-Meaning service');
      await Promise.all(Object.values(workers).map(w => w.stop()));
      jobStatusSubscription.unsubscribe();
      await knowledgeSystem.stop();
      logger.info('Make-Meaning service stopped');
    },
  };
}
