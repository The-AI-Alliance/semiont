/**
 * Assessment Detection Worker
 *
 * Processes assessment-detection jobs: runs AI inference to assess/evaluate
 * passages in the text and creates assessment annotations.
 */

import { JobWorker } from '../job-worker';
import type { AnyJob, AssessmentDetectionJob, RunningJob, AssessmentDetectionParams, AssessmentDetectionProgress, AssessmentDetectionResult, ContentFetcher } from '../types';
import type { JobQueue } from '../job-queue';
import { AnnotationDetection } from './annotation-detection';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { EventBus, userToAgent, type Logger } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import { userId, jobId } from '@semiont/core';
import type { AssessmentMatch } from './detection/motivation-parsers';
import type { InferenceClient } from '@semiont/inference';

export class AssessmentAnnotationWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(
    jobQueue: JobQueue,
    private inferenceClient: InferenceClient,
    private eventBus: EventBus,
    private contentFetcher: ContentFetcher,
    logger: Logger
  ) {
    super(jobQueue, undefined, undefined, logger);
  }

  protected getWorkerName(): string {
    return 'AssessmentAnnotationWorker';
  }

  protected canProcessJob(job: AnyJob): boolean {
    return job.metadata.type === 'assessment-annotation';
  }

  protected async executeJob(job: AnyJob): Promise<AssessmentDetectionResult> {
    if (job.metadata.type !== 'assessment-annotation') {
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
   * Override base class to emit on EventBus
   */
  protected override async emitCompletionEvent(
    job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>,
    result: AssessmentDetectionResult
  ): Promise<void> {
    this.eventBus.get('job:complete').next({
      resourceId: job.params.resourceId,
      userId: userId(job.metadata.userId),
      jobId: jobId(job.metadata.id),
      jobType: 'assessment-annotation',
      result: { result },
    });
  }

  /**
   * Override updateJobProgress to emit events via EventBus
   */
  protected override async updateJobProgress(job: AnyJob): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.metadata.type !== 'assessment-annotation') return;

    // Type guard: only running jobs have progress
    if (job.status !== 'running') {
      return;
    }

    const assJob = job as RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>;

    if (this.isFirstProgress) {
      // First progress update - record job started
      this.isFirstProgress = false;
      this.eventBus.get('job:start').next({
        resourceId: assJob.params.resourceId,
        userId: userId(assJob.metadata.userId),
        jobId: jobId(assJob.metadata.id),
        jobType: assJob.metadata.type,
      });
    } else {
      // Intermediate progress - record job progress
      this.eventBus.get('job:report-progress').next({
        resourceId: assJob.params.resourceId,
        userId: userId(assJob.metadata.userId),
        jobId: jobId(assJob.metadata.id),
        jobType: assJob.metadata.type,
        percentage: assJob.progress.percentage,
        progress: { progress: assJob.progress },
      });
      // Ephemeral progress for real-time UI updates
      const resourceBus = this.eventBus.scope(assJob.params.resourceId);
      resourceBus.get('mark:progress').next({
        status: assJob.progress.stage,
        message: assJob.progress.message,
        percentage: assJob.progress.percentage
      });
    }
  }

  protected override async handleJobFailure(job: AnyJob, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, record via EventBus
    if (job.status === 'failed' && job.metadata.type === 'assessment-annotation') {
      const aJob = job as AssessmentDetectionJob;

      this.eventBus.get('job:fail').next({
        resourceId: aJob.params.resourceId,
        userId: userId(aJob.metadata.userId),
        jobId: jobId(aJob.metadata.id),
        jobType: aJob.metadata.type,
        error: 'Assessment detection failed. Please try again later.',
      });
    }
  }

  private async processAssessmentDetectionJob(job: RunningJob<AssessmentDetectionParams, AssessmentDetectionProgress>): Promise<AssessmentDetectionResult> {
    this.logger?.info('Processing assessment detection job', {
      resourceId: job.params.resourceId,
      jobId: job.metadata.id
    });

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

    // Fetch content via ContentFetcher
    const content = await AnnotationDetection.fetchContent(this.contentFetcher, job.params.resourceId);

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
      content,
      this.inferenceClient,
      job.params.instructions,
      job.params.tone,
      job.params.density
    );

    this.logger?.info('Found assessments to create', { count: assessments.length });

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
        await this.createAssessmentAnnotation(job.params.resourceId, job.metadata, assessment);
        created++;
      } catch (error) {
        this.logger?.error('Failed to create assessment', { error });
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
    this.logger?.info('Assessment detection complete', { created, total: assessments.length });

    // Return result - base class will use this for CompleteJob and emitCompletionEvent
    return {
      assessmentsFound: assessments.length,
      assessmentsCreated: created
    };
  }

  private async createAssessmentAnnotation(
    resourceId: ResourceId,
    metadata: import('../types').JobMetadata,
    assessment: AssessmentMatch
  ): Promise<void> {
    const annotationIdVal = generateAnnotationId();

    const creator = userToAgent({
      id: metadata.userId,
      name: metadata.userName,
      email: metadata.userEmail,
      domain: metadata.userDomain,
    });

    // Create W3C annotation with motivation: assessing
    // Use both TextPositionSelector and TextQuoteSelector (with prefix/suffix for fuzzy anchoring)
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      'id': annotationIdVal,
      'motivation': 'assessing' as const,
      creator,
      created: new Date().toISOString(),
      'target': {
        type: 'SpecificResource' as const,
        source: resourceId as string,
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

    this.eventBus.get('mark:create').next({
      annotation,
      userId: userId(metadata.userId),
      resourceId,
    });
  }
}
