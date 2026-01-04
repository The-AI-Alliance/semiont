/**
 * Assessment Detection Worker
 *
 * Processes assessment-detection jobs: runs AI inference to assess/evaluate
 * passages in the text and creates assessment annotations.
 */

import { JobWorker } from '@semiont/jobs';
import type { Job, AssessmentDetectionJob } from '@semiont/jobs';
import { ResourceQueryService } from '../../services/resource-queries';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '@semiont/core';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { getPrimaryRepresentation, decodeRepresentation, validateAndCorrectOffsets } from '@semiont/api-client';
import { generateText } from '@semiont/inference';
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
    const assessments = await this.detectAssessments(content, job.instructions, job.tone, job.density);

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

  private async detectAssessments(
    content: string,
    instructions?: string,
    tone?: string,
    density?: number
  ): Promise<AssessmentMatch[]> {
    // Build prompt with user instructions taking priority
    let prompt: string;

    if (instructions) {
      // User provided specific instructions - minimal prompt, let instructions drive behavior
      const toneGuidance = tone ? ` Use a ${tone} tone.` : '';
      const densityGuidance = density
        ? `\n\nAim for approximately ${density} assessments per 2000 words of text.`
        : ''; // Let user instructions determine density

      prompt = `Assess passages in this text following these instructions:

${instructions}${toneGuidance}${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of assessments. Each assessment must have:
- "exact": the exact text passage being assessed (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage
- "assessment": your assessment following the instructions above

Return ONLY a valid JSON array, no additional text or explanation.

Example:
[
  {"exact": "the quarterly revenue target", "start": 142, "end": 169, "prefix": "We established ", "suffix": " for Q4 2024.", "assessment": "This target seems ambitious given market conditions. Consider revising based on recent trends."}
]`;
    } else {
      // No specific instructions - fall back to analytical/evaluation mode
      const toneGuidance = tone
        ? `\n\nTone: Use a ${tone} style in your assessments.`
        : '';
      const densityGuidance = density
        ? `\n- Aim for approximately ${density} assessments per 2000 words`
        : `\n- Aim for 2-6 assessments per 2000 words (focus on key passages)`;

      prompt = `Identify passages in this text that merit critical assessment or evaluation.
For each passage, provide analysis of its validity, strength, or implications.${toneGuidance}

Guidelines:
- Select passages containing claims, arguments, conclusions, or assertions
- Assess evidence quality, logical soundness, or practical implications
- Provide assessments that ADD INSIGHT beyond restating the text
- Focus on passages where evaluation would help readers form judgments
- Keep assessments concise yet substantive (1-3 sentences typically)${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of assessments. Each assessment should have:
- "exact": the exact text passage being assessed (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage
- "assessment": your analytical assessment (1-3 sentences, evaluate validity/strength/implications)

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "AI will replace most jobs by 2030", "start": 52, "end": 89, "prefix": "Many experts predict that ", "suffix": ", fundamentally reshaping", "assessment": "This claim lacks nuance and supporting evidence. Employment patterns historically show job transformation rather than wholesale replacement. The timeline appears speculative without specific sector analysis."}
]`;
    }

    console.log(`[AssessmentDetectionWorker] Sending request to AI with content length: ${content.substring(0, 8000).length}`);

    const response = await generateText(
      prompt,
      this.config,
      3000,  // maxTokens: Higher for assessment text
      0.3    // temperature: Lower for analytical consistency
    );

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
