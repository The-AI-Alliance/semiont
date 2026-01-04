/**
 * Comment Detection Worker
 *
 * Processes comment-detection jobs: runs AI inference to identify passages
 * that would benefit from explanatory comments and creates comment annotations.
 */

import { JobWorker } from './job-worker';
import type { Job, CommentDetectionJob } from '../types';
import { ResourceQueryService } from '../../services/resource-queries';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '../../lib/uri-utils';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { getPrimaryRepresentation, decodeRepresentation, validateAndCorrectOffsets } from '@semiont/api-client';
import { generateText } from '../../inference/factory';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';

interface CommentMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  comment: string;
}

export class CommentDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(private config: EnvironmentConfig) {
    super();
  }

  protected getWorkerName(): string {
    return 'CommentDetectionWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'comment-detection';
  }

  protected async executeJob(job: Job): Promise<void> {
    if (job.type !== 'comment-detection') {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    await this.processCommentDetectionJob(job);
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: Job): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.type !== 'comment-detection') return;

    const cdJob = job as CommentDetectionJob;
    if (!cdJob.progress) return;

    const eventStore = await createEventStore(this.config);
    const baseEvent = {
      resourceId: cdJob.resourceId,
      userId: cdJob.userId,
      version: 1,
    };

    // Determine if this is completion (100% and has result)
    const isComplete = cdJob.progress.percentage === 100 && cdJob.result;

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      await eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: cdJob.id,
          jobType: cdJob.type,
        },
      });
    } else if (isComplete) {
      // Final update - emit job.completed
      await eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: cdJob.id,
          jobType: cdJob.type,
          result: cdJob.result,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      await eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: cdJob.id,
          jobType: cdJob.type,
          progress: cdJob.progress,
        },
      });
    }
  }

  protected override async handleJobFailure(job: Job, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.type === 'comment-detection') {
      const cdJob = job as CommentDetectionJob;
      const eventStore = await createEventStore(this.config);

      // Log the full error details to backend logs (already logged by parent)
      // Send generic error message to frontend
      await eventStore.appendEvent({
        type: 'job.failed',
        resourceId: cdJob.resourceId,
        userId: cdJob.userId,
        version: 1,
        payload: {
          jobId: cdJob.id,
          jobType: cdJob.type,
          error: 'Comment detection failed. Please try again later.',
        },
      });
    }
  }

  private async processCommentDetectionJob(job: CommentDetectionJob): Promise<void> {
    console.log(`[CommentDetectionWorker] Processing comment detection for resource ${job.resourceId} (job: ${job.id})`);

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
      message: 'Analyzing text and generating comments...'
    };
    await this.updateJobProgress(job);

    // Use AI to detect passages needing comments
    const comments = await this.detectComments(content, job.instructions, job.tone, job.density);

    console.log(`[CommentDetectionWorker] Found ${comments.length} comments to create`);

    // Update progress
    job.progress = {
      stage: 'creating',
      percentage: 60,
      message: `Creating ${comments.length} annotations...`
    };
    await this.updateJobProgress(job);

    // Create annotations for each comment
    let created = 0;
    for (const comment of comments) {
      try {
        await this.createCommentAnnotation(job.resourceId, job.userId, comment);
        created++;
      } catch (error) {
        console.error(`[CommentDetectionWorker] Failed to create comment:`, error);
      }
    }

    // Complete job
    job.result = {
      commentsFound: comments.length,
      commentsCreated: created
    };

    job.progress = {
      stage: 'creating',
      percentage: 100,
      message: `Complete! Created ${created} comments`
    };

    await this.updateJobProgress(job);
    console.log(`[CommentDetectionWorker] ✅ Created ${created}/${comments.length} comments`);
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

  private async detectComments(
    content: string,
    instructions?: string,
    tone?: string,
    density?: number
  ): Promise<CommentMatch[]> {
    // Build prompt with user instructions taking priority
    let prompt: string;

    if (instructions) {
      // User provided specific instructions - minimal prompt, let instructions drive behavior
      const toneGuidance = tone ? ` Use a ${tone} tone.` : '';
      const densityGuidance = density
        ? `\n\nAim for approximately ${density} comments per 2000 words of text.`
        : ''; // Let user instructions determine density

      prompt = `Add comments to passages in this text following these instructions:

${instructions}${toneGuidance}${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of comments. Each comment must have:
- "exact": the exact text passage being commented on (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage
- "comment": your comment following the instructions above

Return ONLY a valid JSON array, no additional text or explanation.

Example:
[
  {"exact": "the quarterly review meeting", "start": 142, "end": 169, "prefix": "We need to schedule ", "suffix": " for next month.", "comment": "Who will lead this? Should we invite the external auditors?"}
]`;
    } else {
      // No specific instructions - fall back to explanatory/educational mode
      const toneGuidance = tone
        ? `\n\nTone: Use a ${tone} style in your comments.`
        : '';
      const densityGuidance = density
        ? `\n- Aim for approximately ${density} comments per 2000 words`
        : `\n- Aim for 3-8 comments per 2000 words (not too sparse or dense)`;

      prompt = `Identify passages in this text that would benefit from explanatory comments.
For each passage, provide contextual information, clarification, or background.${toneGuidance}

Guidelines:
- Select passages that reference technical terms, historical figures, complex concepts, or unclear references
- Provide comments that ADD VALUE beyond restating the text
- Focus on explanation, background, or connections to other ideas
- Avoid obvious or trivial comments
- Keep comments concise (1-3 sentences typically)${densityGuidance}

Text to analyze:
---
${content.substring(0, 8000)}
---

Return a JSON array of comments. Each comment should have:
- "exact": the exact text passage being commented on (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage
- "comment": your explanatory comment (1-3 sentences, provide context/background/clarification)

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "Ouranos", "start": 52, "end": 59, "prefix": "In the beginning, ", "suffix": " ruled the universe", "comment": "Ouranos (also spelled Uranus) is the primordial Greek deity personifying the sky. In Hesiod's Theogony, he is the son and husband of Gaia (Earth) and father of the Titans."}
]`;
    }

    console.log(`[CommentDetectionWorker] Sending request to AI with content length: ${content.substring(0, 8000).length}`);

    const response = await generateText(
      prompt,
      this.config,
      3000,  // maxTokens: Higher than highlights/assessments due to comment text
      0.4    // temperature: Slightly higher to allow creative context
    );

    console.log(`[CommentDetectionWorker] Got response from AI`);

    // Parse and validate response
    return this.parseComments(response, content);
  }

  private parseComments(response: string, content: string): CommentMatch[] {
    try {
      // Clean up markdown code fences if present
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) {
        console.warn('[CommentDetectionWorker] Response is not an array');
        return [];
      }

      // Validate and filter
      const valid = parsed.filter((c: any) =>
        c &&
        typeof c.exact === 'string' &&
        typeof c.start === 'number' &&
        typeof c.end === 'number' &&
        typeof c.comment === 'string' &&
        c.comment.trim().length > 0
      );

      console.log(`[CommentDetectionWorker] Parsed ${valid.length} valid comments from ${parsed.length} total`);

      // Validate and correct AI's offsets, then extract proper context
      // AI sometimes returns offsets that don't match the actual text position
      const validatedComments: CommentMatch[] = [];

      for (const comment of valid) {
        try {
          const validated = validateAndCorrectOffsets(content, comment.start, comment.end, comment.exact);
          validatedComments.push({
            ...comment,
            start: validated.start,
            end: validated.end,
            prefix: validated.prefix,
            suffix: validated.suffix
          });
        } catch (error) {
          console.warn(`[CommentDetectionWorker] Skipping invalid comment "${comment.exact}":`, error);
          // Skip this comment - AI hallucinated text that doesn't exist
        }
      }

      return validatedComments;
    } catch (error) {
      console.error('[CommentDetectionWorker] Failed to parse AI response:', error);
      return [];
    }
  }

  private async createCommentAnnotation(
    resourceId: ResourceId,
    userId_: string,
    comment: CommentMatch
  ): Promise<void> {
    const eventStore = await createEventStore(this.config);
    const backendUrl = this.config.services.backend?.publicURL;

    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }

    const resourceUri = resourceIdToURI(resourceId, backendUrl);
    const annotationId = generateAnnotationId(backendUrl);

    // Create W3C-compliant annotation with motivation: "commenting"
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id: annotationId,
      motivation: 'commenting' as const,
      target: {
        type: 'SpecificResource' as const,
        source: resourceUri,
        selector: [
          {
            type: 'TextPositionSelector' as const,
            start: comment.start,
            end: comment.end
          },
          {
            type: 'TextQuoteSelector' as const,
            exact: comment.exact,
            prefix: comment.prefix || '',
            suffix: comment.suffix || ''
          }
        ]
      },
      body: [
        {
          type: 'TextualBody' as const,
          value: comment.comment,
          purpose: 'commenting' as const,
          format: 'text/plain',
          language: 'en'
        }
      ]
    };

    // Append annotation.added event to Event Store
    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId,
      userId: userId(userId_),
      version: 1,
      payload: {
        annotation
      }
    });

    console.log(`[CommentDetectionWorker] Created comment annotation ${annotationId} for "${comment.exact.substring(0, 50)}..."`);
  }
}
