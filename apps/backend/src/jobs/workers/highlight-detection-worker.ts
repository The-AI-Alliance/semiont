/**
 * Highlight Detection Worker
 *
 * Processes highlight-detection jobs: runs AI inference to find passages
 * that should be highlighted and creates highlight annotations.
 */

import { JobWorker } from './job-worker';
import type { Job, HighlightDetectionJob } from '../types';
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
    const highlights = await this.detectHighlights(content, job.instructions);

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

  private async detectHighlights(content: string, instructions?: string): Promise<HighlightMatch[]> {
    const instructionsText = instructions
      ? `\n\nUser instructions: ${instructions}`
      : '';

    const prompt = `Identify passages in this text that should be highlighted as important or noteworthy.${instructionsText}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of highlights. Each highlight should have:
- "exact": the exact text to highlight (quoted verbatim from the source)
- "start": character offset where the text starts
- "end": character offset where the text ends
- "prefix": up to 32 characters of text immediately before the highlighted passage (helps identify correct occurrence)
- "suffix": up to 32 characters of text immediately after the highlighted passage (helps identify correct occurrence)

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "important passage here", "start": 42, "end": 64, "prefix": "some context ", "suffix": " more text"}
]`;

    const response = await generateText(prompt, this.config, 2000, 0.3);

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
      return highlights.map(highlight => {
        const validated = validateAndCorrectOffsets(content, highlight.start, highlight.end, highlight.exact);
        return {
          ...highlight,
          start: validated.start,
          end: validated.end,
          prefix: validated.prefix,
          suffix: validated.suffix
        };
      });
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
