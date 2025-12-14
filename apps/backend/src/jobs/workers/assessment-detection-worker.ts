/**
 * Assessment Detection Worker
 *
 * Processes assessment-detection jobs: runs AI inference to assess/evaluate
 * passages in the text and creates assessment annotations.
 */

import { JobWorker } from './job-worker';
import type { Job, AssessmentDetectionJob } from '../types';
import { ResourceQueryService } from '../../services/resource-queries';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '../../lib/uri-utils';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { getPrimaryRepresentation, decodeRepresentation } from '../../utils/resource-helpers';
import { generateText } from '../../inference/factory';
import { validateAndCorrectOffsets } from '../../lib/text-context';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';

interface AssessmentMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  assessment: string;
}

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
    const resource = await ResourceQueryService.getResourceMetadata(job.resourceId, this.config);

    if (!resource) {
      throw new Error(`Resource ${job.resourceId} not found`);
    }

    // Emit job.started
    job.progress = {
      stage: 'analyzing',
      percentage: 10,
      message: 'Loading resource...'
    };
    await this.updateJobProgress(job);

    // Load content
    const content = await this.loadResourceContent(job.resourceId);
    if (!content) {
      throw new Error(`Could not load content for resource ${job.resourceId}`);
    }

    // Update progress
    job.progress = {
      stage: 'analyzing',
      percentage: 30,
      message: 'Analyzing text...'
    };
    await this.updateJobProgress(job);

    // Use AI to detect assessments
    const assessments = await this.detectAssessments(content, job.instructions);

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

  private async loadResourceContent(resourceId: ResourceId): Promise<string | null> {
    const resource = await ResourceQueryService.getResourceMetadata(resourceId, this.config);
    if (!resource) return null;

    const primaryRep = getPrimaryRepresentation(resource);
    if (!primaryRep) return null;

    // Only process text content
    const baseMediaType = primaryRep.mediaType?.split(';')[0]?.trim() || '';
    if (baseMediaType !== 'text/plain' && baseMediaType !== 'text/markdown') {
      return null;
    }

    if (!primaryRep.checksum || !primaryRep.mediaType) return null;

    const basePath = this.config.services.filesystem!.path;
    const projectRoot = this.config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);
    const contentBuffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
    return decodeRepresentation(contentBuffer, primaryRep.mediaType);
  }

  private async detectAssessments(content: string, instructions?: string): Promise<AssessmentMatch[]> {
    const instructionsText = instructions
      ? `\n\nUser instructions: ${instructions}`
      : '';

    const prompt = `Assess and evaluate key passages in this text.${instructionsText}

For each passage worth assessing, provide:
- The exact text from the document (quoted verbatim)
- Your assessment or evaluation of that passage
- Character offsets (start and end)
- Context before and after the passage

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of assessments. Each assessment should have:
- "exact": the exact text being assessed (quoted verbatim from the source)
- "start": character offset where the text starts
- "end": character offset where the text ends
- "prefix": up to 32 characters of text immediately before the assessed passage (helps identify correct occurrence)
- "suffix": up to 32 characters of text immediately after the assessed passage (helps identify correct occurrence)
- "assessment": your evaluation or assessment of this passage

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {
    "exact": "passage to assess",
    "start": 42,
    "end": 59,
    "prefix": "some context ",
    "suffix": " more text",
    "assessment": "This claim is well-supported by evidence..."
  }
]`;

    const response = await generateText(prompt, this.config, 3000, 0.3);

    // Parse JSON response
    try {
      // Clean up response - remove markdown code fences if present
      let cleaned = response.trim();
      if (cleaned.startsWith('```json') || cleaned.startsWith('```')) {
        cleaned = cleaned.slice(cleaned.indexOf('\n') + 1);
        const endIndex = cleaned.lastIndexOf('```');
        if (endIndex !== -1) {
          cleaned = cleaned.slice(0, endIndex);
        }
      }

      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        console.warn('[AssessmentDetectionWorker] AI response was not an array');
        return [];
      }

      // Validate and filter results
      const assessments = parsed.filter((a: any) =>
        a && typeof a.exact === 'string' &&
        typeof a.start === 'number' &&
        typeof a.end === 'number' &&
        typeof a.assessment === 'string'
      );

      // Validate and correct AI's offsets, then extract proper context
      // AI sometimes returns offsets that don't match the actual text position
      const validatedAssessments: AssessmentMatch[] = [];

      for (const assessment of assessments) {
        try {
          const validated = validateAndCorrectOffsets(content, assessment.start, assessment.end, assessment.exact);
          validatedAssessments.push({
            ...assessment,
            start: validated.start,
            end: validated.end,
            prefix: validated.prefix,
            suffix: validated.suffix
          });
        } catch (error) {
          console.warn(`[AssessmentDetectionWorker] Skipping invalid assessment "${assessment.exact}":`, error);
          // Skip this assessment - AI hallucinated text that doesn't exist
        }
      }

      return validatedAssessments;
    } catch (error) {
      console.error('[AssessmentDetectionWorker] Failed to parse AI response:', error);
      console.error('Raw response:', response);
      return [];
    }
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
