/**
 * Assessment Detection Worker
 *
 * Processes assessment-detection jobs: runs AI inference to assess/evaluate
 * passages in the text and creates assessment annotations.
 */

import { JobWorker } from '@semiont/jobs';
import type { Job, AssessmentDetectionJob } from '@semiont/jobs';
import { ResourceContext, AnnotationDetection } from '@semiont/make-meaning';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '@semiont/core';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';
import type { AssessmentMatch } from '@semiont/inference';

export class AssessmentDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(private config: EnvironmentConfig) {
    super();
  }

  protected getWorkerName(): string {
    return 'AssessmentDetectionWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'assessment-detection';
  }

  protected async executeJob(job: Job): Promise<void> {
    if (job.type !== 'assessment-detection') {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    await this.processAssessmentDetectionJob(job);
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: Job): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.type !== 'assessment-detection') return;

    const assJob = job as AssessmentDetectionJob;
    if (!assJob.progress) return;

    const eventStore = await createEventStore(this.config);
    const baseEvent = {
      resourceId: assJob.resourceId,
      userId: assJob.userId,
      version: 1,
    };

    // Determine if this is completion (100% and has result)
    const isComplete = assJob.progress.percentage === 100 && assJob.result;

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      await eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: assJob.id,
          jobType: assJob.type,
        },
      });
    } else if (isComplete) {
      // Final update - emit job.completed
      await eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: assJob.id,
          jobType: assJob.type,
          result: assJob.result,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      await eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: assJob.id,
          jobType: assJob.type,
          progress: assJob.progress,
        },
      });
    }
  }

  protected override async handleJobFailure(job: Job, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.type === 'assessment-detection') {
      const aJob = job as AssessmentDetectionJob;
      const eventStore = await createEventStore(this.config);

      // Log the full error details to backend logs (already logged by parent)
      // Send generic error message to frontend
      await eventStore.appendEvent({
        type: 'job.failed',
        resourceId: aJob.resourceId,
        userId: aJob.userId,
        version: 1,
        payload: {
          jobId: aJob.id,
          jobType: aJob.type,
          error: 'Assessment detection failed. Please try again later.',
        },
      });
    }
  }

  private async processAssessmentDetectionJob(job: AssessmentDetectionJob): Promise<void> {
    console.log(`[AssessmentDetectionWorker] Processing assessment detection for resource ${job.resourceId} (job: ${job.id})`);

    // Fetch resource content
    const resource = await ResourceContext.getResourceMetadata(job.resourceId, this.config);

    if (!resource) {
      throw new Error(`Resource ${job.resourceId} not found`);
    }

    // Emit job.started and start analyzing
    job.progress = {
      stage: 'analyzing',
      percentage: 10,
      message: 'Loading resource...'
    };
    await this.updateJobProgress(job);

    // Update progress
    job.progress = {
      stage: 'analyzing',
      percentage: 30,
      message: 'Analyzing text...'
    };
    await this.updateJobProgress(job);

    // Use AI to detect assessments
    const assessments = await AnnotationDetection.detectAssessments(
      job.resourceId,
      this.config,
      job.instructions,
      job.tone,
      job.density
    );

    console.log(`[AssessmentDetectionWorker] Found ${assessments.length} assessments to create`);

    // Update progress
    job.progress = {
      stage: 'creating',
      percentage: 60,
      message: `Creating ${assessments.length} annotations...`
    };
    await this.updateJobProgress(job);

    // Create annotations for each assessment
    let created = 0;
    for (const assessment of assessments) {
      try {
        await this.createAssessmentAnnotation(job.resourceId, job.userId, assessment);
        created++;
      } catch (error) {
        console.error(`[AssessmentDetectionWorker] Failed to create assessment:`, error);
      }
    }

    // Complete job
    job.result = {
      assessmentsFound: assessments.length,
      assessmentsCreated: created
    };

    job.progress = {
      stage: 'creating',
      percentage: 100,
      message: `Complete! Created ${created} assessments`
    };

    await this.updateJobProgress(job);
    console.log(`[AssessmentDetectionWorker] ✅ Created ${created}/${assessments.length} assessments`);
  }

  private async createAssessmentAnnotation(
    resourceId: ResourceId,
    creatorUserId: string,
    assessment: AssessmentMatch
  ): Promise<void> {
    const eventStore = await createEventStore(this.config);
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

    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId,
      userId: userId(creatorUserId),
      version: 1,
      payload: { annotation }
    });
  }
}
