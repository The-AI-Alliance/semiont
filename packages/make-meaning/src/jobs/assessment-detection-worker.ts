/**
 * Assessment Detection Worker
 *
 * Processes assessment-detection jobs: runs AI inference to assess/evaluate
 * passages in the text and creates assessment annotations.
 */

import { JobWorker } from '@semiont/jobs';
import type { AnyJob, AssessmentDetectionJob, JobQueue, RunningJob, AssessmentDetectionParams, AssessmentDetectionProgress, AssessmentDetectionResult } from '@semiont/jobs';
import { ResourceContext, AnnotationDetection } from '..';
import { EventStore, generateAnnotationId } from '@semiont/event-sourcing';
import { resourceIdToURI, EventBus } from '@semiont/core';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';
import type { AssessmentMatch } from '../detection/motivation-parsers';
import type { InferenceClient } from '@semiont/inference';

export class AssessmentDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(
    jobQueue: JobQueue,
    private config: EnvironmentConfig,
    private eventStore: EventStore,
    private inferenceClient: InferenceClient,
    private eventBus: EventBus
  ) {
    super(jobQueue);
  }

  protected getWorkerName(): string {
    return 'AssessmentDetectionWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'assessment-detection';
  }

  protected async executeJob(job: AnyJob): Promise<AssessmentDetectionResult> {
    if (job.metadata.type !== 'assessment-detection') {
      throw new Error(`Invalid job type: ${job.metadata.type}`);
    }

    // Type guard: job must be running to execute
    if (job.status !== 'running') {
      throw new Error(`Job must be in running state to execute, got: ${job.status}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    return await this.processAssessmentDetectionJob(job as RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>);
  }

  /**
   * Emit completion event with result data
   * Override base class to emit job.completed event
   */
  protected override async emitCompletionEvent(
    job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>,
    result: AssessmentDetectionResult
  ): Promise<void> {
    const completedEvent = await this.eventStore.appendEvent({
      type: 'job.completed',
      resourceId: job.params.resourceId,
      userId: job.metadata.userId,
      version: 1,
      payload: {
        jobId: job.metadata.id,
        jobType: 'assessment-detection',
        result,
      },
    });

    // Emit to EventBus for real-time subscribers
    const resourceBus = this.eventBus.scope(job.params.resourceId);
    resourceBus.get('detection:completed').next(completedEvent.event as Extract<import('@semiont/core').ResourceEvent, { type: 'job.completed' }>);
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.metadata.type !== 'assessment-detection') return;

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const assJob = job as RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>;

    const baseEvent = {
      resourceId: assJob.params.resourceId,
      userId: assJob.metadata.userId,
      version: 1,
    };

    const resourceBus = this.eventBus.scope(assJob.params.resourceId);

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      const startedEvent = await this.eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: assJob.metadata.id,
          jobType: assJob.metadata.type,
        },
      });
      resourceBus.get('detection:started').next(startedEvent.event as Extract<import('@semiont/core').ResourceEvent, { type: 'job.started' }>);
    } else {
      // Intermediate progress - emit job.progress
      // Note: job.completed is now handled by emitCompletionEvent()
      await this.eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: assJob.metadata.id,
          jobType: assJob.metadata.type,
          progress: assJob.progress,
        },
      });
      resourceBus.get('detection:progress').next({
        status: assJob.progress.stage,
        message: assJob.progress.message,
        percentage: assJob.progress.percentage
      });
    }
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.metadata.type === 'assessment-detection') {
      const aJob = job as AssessmentDetectionJob;

      // Log the full error details to backend logs (already logged by parent)
      // Send generic error message to frontend
      await this.eventStore.appendEvent({
        type: 'job.failed',
        resourceId: aJob.params.resourceId,
        userId: aJob.metadata.userId,
        version: 1,
        payload: {
          jobId: aJob.metadata.id,
          jobType: aJob.metadata.type,
          error: 'Assessment detection failed. Please try again later.',
        },
      });
    }
  }

  private async processAssessmentDetectionJob(job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>): Promise<AssessmentDetectionResult> {
    console.log(`[AssessmentDetectionWorker] Processing assessment detection for resource ${job.params.resourceId} (job: ${job.metadata.id})`);

    // Fetch resource content
    const resource = await ResourceContext.getResourceMetadata(job.params.resourceId, this.config);

    if (!resource) {
      throw new Error(`Resource ${job.params.resourceId} not found`);
    }

    // Emit job.started and start analyzing
    let updatedJob: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress> = {
      ...job,
      progress: {
        stage: 'analyzing',
        percentage: 10,
        message: 'Loading resource...'
      }
    };
    await this.updateJobProgress(updatedJob);

    // Update progress
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'analyzing',
        percentage: 30,
        message: 'Analyzing text...'
      }
    };
    await this.updateJobProgress(updatedJob);

    // Use AI to detect assessments
    const assessments = await AnnotationDetection.detectAssessments(
      job.params.resourceId,
      this.config,
      this.inferenceClient,
      job.params.instructions,
      job.params.tone,
      job.params.density
    );

    console.log(`[AssessmentDetectionWorker] Found ${assessments.length} assessments to create`);

    // Update progress
    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 60,
        message: `Creating ${assessments.length} annotations...`
      }
    };
    await this.updateJobProgress(updatedJob);

    // Create annotations for each assessment
    let created = 0;
    for (const assessment of assessments) {
      try {
        await this.createAssessmentAnnotation(job.params.resourceId, job.metadata.userId, assessment);
        created++;
      } catch (error) {
        console.error(`[AssessmentDetectionWorker] Failed to create assessment:`, error);
      }
    }

    updatedJob = {
      ...updatedJob,
      progress: {
        stage: 'creating',
        percentage: 100,
        message: `Complete! Created ${created} assessments`
      }
    };

    await this.updateJobProgress(updatedJob);
    console.log(`[AssessmentDetectionWorker] ✅ Created ${created}/${assessments.length} assessments`);

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      assessmentsFound: assessments.length,
      assessmentsCreated: created
    };
  }

  private async createAssessmentAnnotation(
    resourceId: ResourceId,
    creatorUserId: string,
    assessment: AssessmentMatch
  ): Promise<void> {
    const backendUrl = this.config.services.backend?.publicURL;
    if (!backendUrl) throw new Error('Backend publicURL not configured');

    const annotationId = generateAnnotationId(backendUrl);
    const resourceUri = resourceIdToURI(resourceId, backendUrl);

    // Create W3C annotation with motivation: assessing
    // Use both TextPositionSelector and TextQuoteSelector (with prefix/suffix for fuzzy anchoring)
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      'id': annotationId,
      'motivation': 'assessing' as const,
      'creator': userId(creatorUserId),
      'created': new Date().toISOString(),
      'target': {
        type: 'SpecificResource' as const,
        source: resourceUri,
        selector: [
          {
            type: 'TextPositionSelector' as const,
            start: assessment.start,
            end: assessment.end,
          },
          {
            type: 'TextQuoteSelector' as const,
            exact: assessment.exact,
            ...(assessment.prefix && { prefix: assessment.prefix }),
            ...(assessment.suffix && { suffix: assessment.suffix }),
          },
        ]
      },
      'body': {
        type: 'TextualBody' as const,
        value: assessment.assessment,
        format: 'text/plain'
      }
    };

    await this.eventStore.appendEvent({
      type: 'annotation.added',
      resourceId,
      userId: userId(creatorUserId),
      version: 1,
      payload: { annotation }
    });
  }
}
