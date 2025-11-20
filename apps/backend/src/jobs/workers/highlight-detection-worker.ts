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
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';

interface HighlightMatch {
  exact: string;
  start: number;
  end: number;
}

export class HighlightDetectionWorker extends JobWorker {
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

    await this.processHighlightDetectionJob(job);
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

    // Use AI to detect highlights
    const highlights = await this.detectHighlights(content, job.instructions);

    console.log(`[HighlightDetectionWorker] Found ${highlights.length} highlights to create`);

    // Update progress
    job.progress = {
      stage: 'creating',
      percentage: 60,
      message: `Creating ${highlights.length} highlight annotations...`
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

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "important passage here", "start": 42, "end": 64}
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
      return parsed.filter((h: any) =>
        h && typeof h.exact === 'string' &&
        typeof h.start === 'number' &&
        typeof h.end === 'number'
      );
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
        selector: {
          type: 'TextQuoteSelector' as const,
          exact: highlight.exact
        }
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
