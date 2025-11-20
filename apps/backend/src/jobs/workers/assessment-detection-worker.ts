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
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';

interface AssessmentMatch {
  exact: string;
  start: number;
  end: number;
  assessment: string;
}

export class AssessmentDetectionWorker extends JobWorker {
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

    await this.processAssessmentDetectionJob(job);
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
      message: 'Loading resource content...'
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
      message: 'Analyzing text with AI...'
    };
    await this.updateJobProgress(job);

    // Use AI to detect assessments
    const assessments = await this.detectAssessments(content, job.instructions);

    console.log(`[AssessmentDetectionWorker] Found ${assessments.length} assessments to create`);

    // Update progress
    job.progress = {
      stage: 'creating',
      percentage: 60,
      message: `Creating ${assessments.length} assessment annotations...`
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

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of assessments. Each assessment should have:
- "exact": the exact text being assessed (quoted verbatim from the source)
- "start": character offset where the text starts
- "end": character offset where the text ends
- "assessment": your evaluation or assessment of this passage

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {
    "exact": "passage to assess",
    "start": 42,
    "end": 59,
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
      return parsed.filter((a: any) =>
        a && typeof a.exact === 'string' &&
        typeof a.start === 'number' &&
        typeof a.end === 'number' &&
        typeof a.assessment === 'string'
      );
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
        selector: {
          type: 'TextQuoteSelector' as const,
          exact: assessment.exact
        }
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
