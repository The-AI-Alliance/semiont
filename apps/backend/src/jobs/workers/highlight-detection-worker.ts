/**
 * Highlight Detection Worker
 *
 * Processes highlight-detection jobs: runs AI inference to find passages
 * that should be highlighted and creates highlight annotations.
 */

import { JobWorker } from '@semiont/jobs';
import type { Job, HighlightDetectionJob } from '@semiont/jobs';
import { ResourceQueryService } from '../../services/resource-queries';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '@semiont/core';
import { FilesystemRepresentationStore } from '@semiont/content';
import { getPrimaryRepresentation, decodeRepresentation, validateAndCorrectOffsets } from '@semiont/api-client';
import { generateText } from '@semiont/inference';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';

interface HighlightMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
}

export class HighlightDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(private config: EnvironmentConfig) {
    super();
  }

  protected getWorkerName(): string {
    return 'HighlightDetectionWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'highlight-detection';
  }

  protected async executeJob(job: Job): Promise<void> {
    if (job.type !== 'highlight-detection') {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    await this.processHighlightDetectionJob(job);
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: Job): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.type !== 'highlight-detection') return;

    const hlJob = job as HighlightDetectionJob;
    if (!hlJob.progress) return;

    const eventStore = await createEventStore(this.config);
    const baseEvent = {
      resourceId: hlJob.resourceId,
      userId: hlJob.userId,
      version: 1,
    };

    // Determine if this is completion (100% and has result)
    const isComplete = hlJob.progress.percentage === 100 && hlJob.result;

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      await eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: hlJob.id,
          jobType: hlJob.type,
        },
      });
    } else if (isComplete) {
      // Final update - emit job.completed
      await eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: hlJob.id,
          jobType: hlJob.type,
          result: hlJob.result,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      await eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: hlJob.id,
          jobType: hlJob.type,
          progress: hlJob.progress,
        },
      });
    }
  }

  protected override async handleJobFailure(job: Job, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.type === 'highlight-detection') {
      const hlJob = job as HighlightDetectionJob;
      const eventStore = await createEventStore(this.config);

      // Log the full error details to backend logs (already logged by parent)
      // Send generic error message to frontend
      await eventStore.appendEvent({
        type: 'job.failed',
        resourceId: hlJob.resourceId,
        userId: hlJob.userId,
        version: 1,
        payload: {
          jobId: hlJob.id,
          jobType: hlJob.type,
          error: 'Highlight detection failed. Please try again later.',
        },
      });
    }
  }

  private async processHighlightDetectionJob(job: HighlightDetectionJob): Promise<void> {
    console.log(`[HighlightDetectionWorker] Processing highlight detection for resource ${job.resourceId} (job: ${job.id})`);

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

    // Use AI to detect highlights
    const highlights = await this.detectHighlights(content, job.instructions, job.density);

    console.log(`[HighlightDetectionWorker] Found ${highlights.length} highlights to create`);

    // Update progress
    job.progress = {
      stage: 'creating',
      percentage: 60,
      message: `Creating ${highlights.length} annotations...`
    };
    await this.updateJobProgress(job);

    // Create annotations for each highlight
    let created = 0;
    for (const highlight of highlights) {
      try {
        await this.createHighlightAnnotation(job.resourceId, job.userId, highlight);
        created++;
      } catch (error) {
        console.error(`[HighlightDetectionWorker] Failed to create highlight:`, error);
      }
    }

    // Complete job
    job.result = {
      highlightsFound: highlights.length,
      highlightsCreated: created
    };

    job.progress = {
      stage: 'creating',
      percentage: 100,
      message: `Complete! Created ${created} highlights`
    };

    await this.updateJobProgress(job);
    console.log(`[HighlightDetectionWorker] ✅ Created ${created}/${highlights.length} highlights`);
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

  private async detectHighlights(
    content: string,
    instructions?: string,
    density?: number
  ): Promise<HighlightMatch[]> {
    // Build prompt with user instructions taking priority
    let prompt: string;

    if (instructions) {
      // User provided specific instructions - minimal prompt, let instructions drive behavior
      const densityGuidance = density
        ? `\n\nAim for approximately ${density} highlights per 2000 words of text.`
        : ''; // Let user instructions determine density

      prompt = `Identify passages in this text to highlight following these instructions:

${instructions}${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of highlights. Each highlight must have:
- "exact": the exact text passage to highlight (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage

Return ONLY a valid JSON array, no additional text or explanation.

Example:
[
  {"exact": "revenue grew 45% year-over-year", "start": 142, "end": 174, "prefix": "In Q3 2024, ", "suffix": ", exceeding all forecasts."}
]`;
    } else {
      // No specific instructions - fall back to importance/salience mode
      const densityGuidance = density
        ? `\n- Aim for approximately ${density} highlights per 2000 words`
        : `\n- Aim for 3-8 highlights per 2000 words (be selective)`;

      prompt = `Identify passages in this text that merit highlighting for their importance or salience.
Focus on content that readers should notice and remember.

Guidelines:
- Highlight key claims, findings, or conclusions
- Highlight important definitions, terminology, or concepts
- Highlight notable quotes or particularly striking statements
- Highlight critical decisions, action items, or turning points
- Select passages that are SIGNIFICANT, not just interesting
- Avoid trivial or obvious content${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of highlights. Each highlight should have:
- "exact": the exact text passage to highlight (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "we will discontinue support for legacy systems by March 2025", "start": 52, "end": 113, "prefix": "After careful consideration, ", "suffix": ". This decision affects"}
]`;
    }

    console.log(`[HighlightDetectionWorker] Sending request to AI with content length: ${content.substring(0, 8000).length}`);

    const response = await generateText(
      prompt,
      this.config,
      2000,  // maxTokens: Lower than comments/assessments (no body text)
      0.3    // temperature: Low for consistent importance judgments
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
        console.warn('[HighlightDetectionWorker] AI response was not an array');
        return [];
      }

      // Validate and filter results
      const highlights = parsed.filter((h: any) =>
        h && typeof h.exact === 'string' &&
        typeof h.start === 'number' &&
        typeof h.end === 'number'
      );

      // Validate and correct AI's offsets, then extract proper context
      // AI sometimes returns offsets that don't match the actual text position
      const validatedHighlights: HighlightMatch[] = [];

      for (const highlight of highlights) {
        try {
          const validated = validateAndCorrectOffsets(content, highlight.start, highlight.end, highlight.exact);
          validatedHighlights.push({
            ...highlight,
            start: validated.start,
            end: validated.end,
            prefix: validated.prefix,
            suffix: validated.suffix
          });
        } catch (error) {
          console.warn(`[HighlightDetectionWorker] Skipping invalid highlight "${highlight.exact}":`, error);
          // Skip this highlight - AI hallucinated text that doesn't exist
        }
      }

      return validatedHighlights;
    } catch (error) {
      console.error('[HighlightDetectionWorker] Failed to parse AI response:', error);
      console.error('Raw response:', response);
      return [];
    }
  }

  private async createHighlightAnnotation(
    resourceId: ResourceId,
    creatorUserId: string,
    highlight: HighlightMatch
  ): Promise<void> {
    const eventStore = await createEventStore(this.config);
    const backendUrl = this.config.services.backend?.publicURL;
    if (!backendUrl) throw new Error('Backend publicURL not configured');

    const annotationId = generateAnnotationId(backendUrl);
    const resourceUri = resourceIdToURI(resourceId, backendUrl);

    // Create W3C annotation with motivation: highlighting
    // Use both TextPositionSelector and TextQuoteSelector (with prefix/suffix for fuzzy anchoring)
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      'id': annotationId,
      'motivation': 'highlighting' as const,
      'creator': userId(creatorUserId),
      'created': new Date().toISOString(),
      'target': {
        type: 'SpecificResource' as const,
        source: resourceUri,
        selector: [
          {
            type: 'TextPositionSelector' as const,
            start: highlight.start,
            end: highlight.end,
          },
          {
            type: 'TextQuoteSelector' as const,
            exact: highlight.exact,
            ...(highlight.prefix && { prefix: highlight.prefix }),
            ...(highlight.suffix && { suffix: highlight.suffix }),
          },
        ]
      },
      'body': []  // Empty body for highlights
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
