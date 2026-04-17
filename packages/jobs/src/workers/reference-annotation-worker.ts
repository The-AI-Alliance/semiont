/**
 * Reference Detection Worker
 *
 * Processes detection jobs: runs AI inference to find entities in resources
 * and creates annotations for each detected entity via the EventBus.
 *
 * This worker is INDEPENDENT of HTTP clients - it just processes jobs and
 * emits events on the EventBus for all writes.
 */

import { JobWorker } from '../job-worker';
import type { AnyJob, DetectionJob, RunningJob, DetectionParams, DetectionProgress, DetectionResult, ContentFetcher } from '../types';
import type { JobQueue } from '../job-queue-interface';
import { AnnotationDetection } from './annotation-detection';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { EventBus, userToAgent } from '@semiont/core';
import { userId, jobId } from '@semiont/core';
import type { Logger } from '@semiont/core';
import { validateAndCorrectOffsets } from '@semiont/api-client';
import { extractEntities } from './detection/entity-extractor';
import type { InferenceClient } from '@semiont/inference';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

export interface DetectedAnnotation {
  annotation: {
    selector: {
      start: number;
      end: number;
      exact: string;
      prefix?: string;
      suffix?: string;
    };
    entityTypes: string[];
  };
}

export class ReferenceAnnotationWorker extends JobWorker {
  constructor(
    jobQueue: JobQueue,
    private inferenceClient: InferenceClient,
    private generator: Agent,
    private eventBus: EventBus,
    private contentFetcher: ContentFetcher,
    logger: Logger
  ) {
    super(jobQueue, undefined, undefined, logger);
  }

  protected getWorkerName(): string {
    return 'ReferenceAnnotationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'reference-annotation';
  }

  protected async executeJob(job: AnyJob): Promise<DetectionResult> {
    if (job.metadata.type !== 'reference-annotation') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    return await this.processDetectionJob(job as RunningJob<DetectionParams, DetectionProgress>);
  }

  /**
   * Detect entity references in content using AI
   *
   * Public for testing charset handling - see entity-detection-charset.test.ts
   */
  public async detectReferences(
    content: string,
    entityTypes: string[],
    includeDescriptiveReferences: boolean = false
  ): Promise<DetectedAnnotation[]> {
    this.logger?.debug('Detecting entities', {
      entityTypes,
      includeDescriptiveReferences
    });

    const detectedAnnotations: DetectedAnnotation[] = [];

    // Use AI to extract entities (with optional anaphoric/cataphoric references)
    const extractedEntities = await extractEntities(content, entityTypes, this.inferenceClient, includeDescriptiveReferences, this.logger);

    // Validate and correct AI's offsets, then extract proper context
    // AI sometimes returns offsets that don't match the actual text position
    for (const entity of extractedEntities) {
      try {
        const validated = validateAndCorrectOffsets(
          content,
          entity.startOffset,
          entity.endOffset,
          entity.exact
        );

        const annotation: DetectedAnnotation = {
          annotation: {
            selector: {
              start: validated.start,
              end: validated.end,
              exact: validated.exact,
              prefix: validated.prefix,
              suffix: validated.suffix,
            },
            entityTypes: [entity.entityType],
          },
        };
        detectedAnnotations.push(annotation);
      } catch (error) {
        this.logger?.warn('Skipping invalid entity', { exact: entity.exact, error });
        // Skip this entity - AI hallucinated text that doesn't exist
      }
    }

    return detectedAnnotations;
  }

  private async processDetectionJob(job: RunningJob<DetectionParams, DetectionProgress>): Promise<DetectionResult> {
    this.logger?.info('Processing detection job', { resourceId: job.params.resourceId, jobId: job.metadata.id });
    this.logger?.debug('Entity types to detect', { entityTypes: job.params.entityTypes });

    // Fetch content via ContentFetcher
    const content = await AnnotationDetection.fetchContent(this.contentFetcher, job.params.resourceId);

    let totalFound = 0;
    let totalEmitted = 0;
    let totalErrors = 0;

    // Create updated job with initial progress
    let updatedJob: RunningJob<DetectionParams, DetectionProgress> = {
      ...job,
      progress: {
        totalEntityTypes: job.params.entityTypes.length,
        processedEntityTypes: 0,
        entitiesFound: 0,
        entitiesEmitted: 0
      }
    };
    await this.updateJobProgress(updatedJob);

    // Process each entity type
    for (let i = 0; i < job.params.entityTypes.length; i++) {
      const entityType = job.params.entityTypes[i];

      if (!entityType) continue;

      this.logger?.info('Detecting entity type', {
        entityType,
        progress: `${i + 1}/${job.params.entityTypes.length}`
      });

      // Emit progress BEFORE inference call for immediate user feedback
      updatedJob = {
        ...updatedJob,
        progress: {
          totalEntityTypes: job.params.entityTypes.length,
          processedEntityTypes: i,
          currentEntityType: entityType,
          entitiesFound: totalFound,
          entitiesEmitted: totalEmitted
        }
      };
      await this.updateJobProgress(updatedJob);

      // Detect entities using AI
      const detectedAnnotations = await this.detectReferences(content, [entityType], job.params.includeDescriptiveReferences);

      totalFound += detectedAnnotations.length;
      this.logger?.info('Found entities', { entityType, count: detectedAnnotations.length });

      // Create annotations for each detected entity via EventBus
      for (let idx = 0; idx < detectedAnnotations.length; idx++) {
        const detected = detectedAnnotations[idx];

        if (!detected) {
          this.logger?.warn('Skipping undefined entity', { index: idx });
          continue;
        }

        const referenceId = generateAnnotationId();

        try {
          const creator = userToAgent({
            id: job.metadata.userId,
            name: job.metadata.userName,
            email: job.metadata.userEmail,
            domain: job.metadata.userDomain,
          });

          const annotation = {
            '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
            'type': 'Annotation' as const,
            id: referenceId,
            motivation: 'linking' as const,
            creator,
            generator: this.generator,
            created: new Date().toISOString(),
            target: {
              source: job.params.resourceId as string,
              selector: [
                {
                  type: 'TextPositionSelector' as const,
                  start: detected.annotation.selector.start,
                  end: detected.annotation.selector.end,
                },
                {
                  type: 'TextQuoteSelector' as const,
                  exact: detected.annotation.selector.exact,
                  ...(detected.annotation.selector.prefix && { prefix: detected.annotation.selector.prefix }),
                  ...(detected.annotation.selector.suffix && { suffix: detected.annotation.selector.suffix }),
                },
              ],
            },
            body: (detected.annotation.entityTypes || []).map(et => ({
              type: 'TextualBody' as const,
              value: et,
              purpose: 'tagging' as const,
            })),
            modified: new Date().toISOString(),
          };

          this.eventBus.get('mark:create').next({
            annotation,
            userId: userId(job.metadata.userId),
            resourceId: job.params.resourceId,
          });

          totalEmitted++;

          if ((idx + 1) % 10 === 0 || idx === detectedAnnotations.length - 1) {
            this.logger?.debug('Created annotations for entity type', {
              entityType,
              created: idx + 1,
              total: detectedAnnotations.length
            });
          }

        } catch (error) {
          totalErrors++;
          this.logger?.error('Failed to create annotation', { referenceId, error });
          // Continue processing other entities even if one fails
        }
      }

      this.logger?.info('Completed entity type processing', {
        entityType,
        found: detectedAnnotations.length,
        emitted: detectedAnnotations.length - (totalErrors - (totalFound - totalEmitted))
      });

      // Update progress after processing this entity type
      updatedJob = {
        ...updatedJob,
        progress: {
          totalEntityTypes: job.params.entityTypes.length,
          processedEntityTypes: i + 1,
          currentEntityType: entityType,
          entitiesFound: totalFound,
          entitiesEmitted: totalEmitted
        }
      };
      await this.updateJobProgress(updatedJob);
    }

    this.logger?.info('Detection complete', { totalFound, totalEmitted, totalErrors });

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      totalFound,
      totalEmitted,
      errors: totalErrors
    };
  }

  /**
   * Emit completion event with result data
   * Override base class to emit on EventBus
   */
  protected override async emitCompletionEvent(
    job: RunningJob<DetectionParams, DetectionProgress>,
    result: DetectionResult
  ): Promise<void> {
    this.eventBus.get('job:complete').next({
      resourceId: job.params.resourceId,
      userId: userId(job.metadata.userId),
      jobId: jobId(job.metadata.id),
      jobType: 'reference-annotation',
      result,
    });

    // Emit mark:assist-finished on the resource-scoped bus so the events-stream
    // delivers it to all participants. Previously synthesized by the per-operation SSE route.
    const resourceBus = this.eventBus.scope(String(job.params.resourceId));
    resourceBus.get('mark:assist-finished').next({
      motivation: 'linking',
      resourceId: String(job.params.resourceId),
      status: 'complete',
      percentage: 100,
      foundCount: result.totalFound,
      createdCount: result.totalEmitted,
      message: 'Detection complete',
    });
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, record via EventBus
    if (job.status === 'failed' && job.metadata.type === 'reference-annotation') {
      const detJob = job as DetectionJob;

      this.eventBus.get('job:fail').next({
        resourceId: detJob.params.resourceId,
        userId: userId(detJob.metadata.userId),
        jobId: jobId(detJob.metadata.id),
        jobType: detJob.metadata.type,
        error: 'Entity detection failed. Please try again later.',
      });

      // Emit mark:assist-failed on the resource-scoped bus
      const resourceBus = this.eventBus.scope(String(detJob.params.resourceId));
      resourceBus.get('mark:assist-failed').next({
        resourceId: String(detJob.params.resourceId),
        message: 'Entity detection failed. Please try again later.',
      });
    }
  }

  /**
   * Update job progress and emit ephemeral events via EventBus
   * Overrides base class to emit job lifecycle events and mark:progress events
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update job queue
    await super.updateJobProgress(job);

    // Emit events for detection jobs
    if (job.metadata.type !== 'reference-annotation') {
      return;
    }

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const detJob = job as RunningJob<DetectionParams, DetectionProgress>;

    // Determine update type based on progress state
    const isFirstUpdate = detJob.progress.processedEntityTypes === 0 && !detJob.progress.currentEntityType;

    const currentIndex = detJob.progress.currentEntityType
      ? detJob.params.entityTypes.findIndex(et => et === detJob.progress.currentEntityType)
      : -1;
    const isBeforeProcessing = currentIndex !== -1 && detJob.progress.processedEntityTypes === currentIndex;

    // Get resource-scoped EventBus for progress events
    const resourceBus = this.eventBus.scope(detJob.params.resourceId);
    this.logger?.debug('[EventBus] Scoping to resourceId', { resourceId: detJob.params.resourceId });

    if (isFirstUpdate) {
      // First progress update - record job started via EventBus
      this.eventBus.get('job:start').next({
        resourceId: detJob.params.resourceId,
        userId: userId(detJob.metadata.userId),
        jobId: jobId(detJob.metadata.id),
        jobType: detJob.metadata.type,
      });

      // ALSO emit initial mark:progress for immediate frontend feedback
      this.logger?.debug('[EventBus] Emitting initial mark:progress', {
        resourceId: detJob.params.resourceId,
        currentEntityType: detJob.progress.currentEntityType
      });
      resourceBus.get('mark:progress').next({
        status: 'started',
        message: detJob.progress.currentEntityType
          ? `Starting ${detJob.progress.currentEntityType}...`
          : 'Starting detection...',
        currentEntityType: detJob.progress.currentEntityType,
        percentage: 0,
      });
    } else if (isBeforeProcessing) {
      const percentage = 0;
      this.logger?.debug('[EventBus] Emitting mark:progress (before processing)', {
        resourceId: detJob.params.resourceId,
        currentEntityType: detJob.progress.currentEntityType
      });
      resourceBus.get('mark:progress').next({
        status: 'scanning',
        message: `Starting ${detJob.progress.currentEntityType}...`,
        currentEntityType: detJob.progress.currentEntityType,
        percentage,
      });
    } else {
      // After processing an entity type - record progress via EventBus
      const percentage = Math.round((detJob.progress.processedEntityTypes / detJob.progress.totalEntityTypes) * 100);
      this.eventBus.get('job:report-progress').next({
        resourceId: detJob.params.resourceId,
        userId: userId(detJob.metadata.userId),
        jobId: jobId(detJob.metadata.id),
        jobType: detJob.metadata.type,
        percentage,
        progress: {
          stage: 'scanning',
          percentage,
          message: detJob.progress.currentEntityType
            ? `Processing ${detJob.progress.currentEntityType}`
            : 'Processing...',
          totalEntityTypes: detJob.progress.totalEntityTypes,
          processedEntityTypes: detJob.progress.processedEntityTypes,
          entitiesFound: detJob.progress.entitiesFound,
          entitiesEmitted: detJob.progress.entitiesEmitted,
          currentEntityType: detJob.progress.currentEntityType,
        },
      });

      // PROGRESS EVENT: Emit mark:progress directly to EventBus (ephemeral)
      this.logger?.debug('[EventBus] Emitting mark:progress', {
        resourceId: detJob.params.resourceId,
        currentEntityType: detJob.progress.currentEntityType,
        percentage
      });
      resourceBus.get('mark:progress').next({
        status: 'scanning',
        message: `Processing ${detJob.progress.currentEntityType}`,
        currentEntityType: detJob.progress.currentEntityType,
        percentage,
      });
    }
  }
}
