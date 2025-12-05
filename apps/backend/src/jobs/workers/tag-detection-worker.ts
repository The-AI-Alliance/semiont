/**
 * Tag Detection Worker
 *
 * Processes tag-detection jobs: runs AI inference to identify passages
 * serving specific structural roles (IRAC, IMRAD, Toulmin, etc.) and
 * creates tag annotations with dual-body structure.
 */

import { JobWorker } from './job-worker';
import type { Job, TagDetectionJob } from '../types';
import { ResourceQueryService } from '../../services/resource-queries';
import { createEventStore } from '../../services/event-store-service';
import { generateAnnotationId } from '../../utils/id-generator';
import { resourceIdToURI } from '../../lib/uri-utils';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { getPrimaryRepresentation, decodeRepresentation } from '../../utils/resource-helpers';
import { generateText } from '../../inference/factory';
import { getTagSchema, getTagCategory } from '../../lib/tag-schemas';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';
import { userId } from '@semiont/core';

interface TagMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  category: string;
}

export class TagDetectionWorker extends JobWorker {
  private isFirstProgress = true;

  constructor(private config: EnvironmentConfig) {
    super();
  }

  protected getWorkerName(): string {
    return 'TagDetectionWorker';
  }

  protected canProcessJob(job: Job): boolean {
    return job.type === 'tag-detection';
  }

  protected async executeJob(job: Job): Promise<void> {
    if (job.type !== 'tag-detection') {
      throw new Error(`Invalid job type: ${job.type}`);
    }

    // Reset progress tracking
    this.isFirstProgress = true;
    await this.processTagDetectionJob(job);
  }

  /**
   * Override updateJobProgress to emit events to Event Store
   */
  protected override async updateJobProgress(job: Job): Promise<void> {
    // Call parent to update filesystem
    await super.updateJobProgress(job);

    if (job.type !== 'tag-detection') return;

    const tdJob = job as TagDetectionJob;
    if (!tdJob.progress) return;

    const eventStore = await createEventStore(this.config);
    const baseEvent = {
      resourceId: tdJob.resourceId,
      userId: tdJob.userId,
      version: 1,
    };

    // Determine if this is completion (100% and has result)
    const isComplete = tdJob.progress.percentage === 100 && tdJob.result;

    if (this.isFirstProgress) {
      // First progress update - emit job.started
      this.isFirstProgress = false;
      await eventStore.appendEvent({
        type: 'job.started',
        ...baseEvent,
        payload: {
          jobId: tdJob.id,
          jobType: tdJob.type,
        },
      });
    } else if (isComplete) {
      // Final update - emit job.completed
      await eventStore.appendEvent({
        type: 'job.completed',
        ...baseEvent,
        payload: {
          jobId: tdJob.id,
          jobType: tdJob.type,
          result: tdJob.result,
        },
      });
    } else {
      // Intermediate progress - emit job.progress
      await eventStore.appendEvent({
        type: 'job.progress',
        ...baseEvent,
        payload: {
          jobId: tdJob.id,
          jobType: tdJob.type,
          progress: tdJob.progress,
        },
      });
    }
  }

  protected override async handleJobFailure(job: Job, error: any): Promise<void> {
    // Call parent to handle the failure logic
    await super.handleJobFailure(job, error);

    // If job permanently failed, emit job.failed event
    if (job.status === 'failed' && job.type === 'tag-detection') {
      const tdJob = job as TagDetectionJob;
      const eventStore = await createEventStore(this.config);

      await eventStore.appendEvent({
        type: 'job.failed',
        resourceId: tdJob.resourceId,
        userId: tdJob.userId,
        version: 1,
        payload: {
          jobId: tdJob.id,
          jobType: tdJob.type,
          error: 'Tag detection failed. Please try again later.',
        },
      });
    }
  }

  private async processTagDetectionJob(job: TagDetectionJob): Promise<void> {
    console.log(`[TagDetectionWorker] Processing tag detection for resource ${job.resourceId} (job: ${job.id})`);

    // Validate schema
    const schema = getTagSchema(job.schemaId);
    if (!schema) {
      throw new Error(`Invalid tag schema: ${job.schemaId}`);
    }

    // Validate categories
    for (const category of job.categories) {
      if (!schema.tags.some(t => t.name === category)) {
        throw new Error(`Invalid category "${category}" for schema ${job.schemaId}`);
      }
    }

    // Fetch resource content
    const resource = await ResourceQueryService.getResourceMetadata(job.resourceId, this.config);
    if (!resource) {
      throw new Error(`Resource ${job.resourceId} not found`);
    }

    // Emit job.started
    job.progress = {
      stage: 'analyzing',
      percentage: 10,
      processedCategories: 0,
      totalCategories: job.categories.length,
      message: 'Loading resource...'
    };
    await this.updateJobProgress(job);

    // Load content (FULL document - no truncation for structural analysis)
    const content = await this.loadResourceContent(job.resourceId);
    if (!content) {
      throw new Error(`Could not load content for resource ${job.resourceId}`);
    }

    console.log(`[TagDetectionWorker] Loaded ${content.length} characters for tag detection`);

    // Process each category separately
    const allTags: TagMatch[] = [];
    const byCategory: Record<string, number> = {};

    for (let i = 0; i < job.categories.length; i++) {
      const category = job.categories[i];

      job.progress = {
        stage: 'analyzing',
        percentage: 10 + Math.floor((i / job.categories.length) * 50),
        currentCategory: category,
        processedCategories: i,
        totalCategories: job.categories.length,
        message: `Analyzing ${category}...`
      };
      await this.updateJobProgress(job);

      // Detect tags for this category
      const tags = await this.detectTagsForCategory(content, job.schemaId, category);
      console.log(`[TagDetectionWorker] Found ${tags.length} tags for category "${category}"`);

      allTags.push(...tags);
      byCategory[category] = tags.length;
    }

    // Create annotations
    job.progress = {
      stage: 'creating',
      percentage: 60,
      processedCategories: job.categories.length,
      totalCategories: job.categories.length,
      message: `Creating ${allTags.length} tag annotations...`
    };
    await this.updateJobProgress(job);

    let created = 0;
    for (const tag of allTags) {
      try {
        await this.createTagAnnotation(job.resourceId, job.userId, job.schemaId, tag);
        created++;
      } catch (error) {
        console.error(`[TagDetectionWorker] Failed to create tag:`, error);
      }
    }

    // Complete job
    job.result = {
      tagsFound: allTags.length,
      tagsCreated: created,
      byCategory
    };

    job.progress = {
      stage: 'creating',
      percentage: 100,
      processedCategories: job.categories.length,
      totalCategories: job.categories.length,
      message: `Complete! Created ${created} tags`
    };

    await this.updateJobProgress(job);
    console.log(`[TagDetectionWorker] ✅ Created ${created}/${allTags.length} tags across ${job.categories.length} categories`);
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

  private async detectTagsForCategory(
    content: string,
    schemaId: string,
    category: string
  ): Promise<TagMatch[]> {
    const schema = getTagSchema(schemaId);
    if (!schema) return [];

    const categoryInfo = getTagCategory(schemaId, category);
    if (!categoryInfo) return [];

    // Build prompt with schema context and category-specific guidance
    const prompt = `You are analyzing a text using the ${schema.name} framework.

Schema: ${schema.description}
Domain: ${schema.domain}

Your task: Identify passages that serve the structural role of "${category}".

Category: ${category}
Description: ${categoryInfo.description}
Key questions:
${categoryInfo.examples.map(ex => `- ${ex}`).join('\n')}

Guidelines:
- Focus on STRUCTURAL FUNCTION, not semantic content
- A passage serves the "${category}" role if it performs this function in the document's structure
- Look for passages that explicitly fulfill this role
- Passages can be sentences, paragraphs, or sections
- Aim for precision - only tag passages that clearly serve this structural role
- Typical documents have 1-5 instances of each category (some may have 0)

Text to analyze:
---
${content}
---

Return a JSON array of tags. Each tag should have:
- "exact": the exact text passage (quoted verbatim from source)
- "start": character offset where the passage starts
- "end": character offset where the passage ends
- "prefix": up to 32 characters of text immediately before the passage
- "suffix": up to 32 characters of text immediately after the passage

Return ONLY a valid JSON array, no additional text or explanation.

Example format:
[
  {"exact": "What duty did the defendant owe?", "start": 142, "end": 175, "prefix": "The central question is: ", "suffix": " This question must be"},
  {"exact": "In tort law, a duty of care is established when...", "start": 412, "end": 520, "prefix": "Legal framework:\\n", "suffix": "\\n\\nApplying this standard"}
]`;

    console.log(`[TagDetectionWorker] Sending request to AI for category "${category}" (content: ${content.length} chars)`);

    const response = await generateText(
      prompt,
      this.config,
      4000,  // maxTokens: Higher for full document analysis
      0.2    // temperature: Lower for structural consistency
    );

    console.log(`[TagDetectionWorker] Got response from AI for category "${category}"`);

    // Parse and validate response
    const tags = this.parseTags(response);

    // Add category to each tag
    return tags.map(tag => ({ ...tag, category }));
  }

  private parseTags(response: string): TagMatch[] {
    try {
      // Clean up markdown code fences if present
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) {
        console.warn('[TagDetectionWorker] Response is not an array');
        return [];
      }

      // Validate and filter
      const valid = parsed.filter((t: any) =>
        t &&
        typeof t.exact === 'string' &&
        typeof t.start === 'number' &&
        typeof t.end === 'number' &&
        t.exact.trim().length > 0
      );

      console.log(`[TagDetectionWorker] Parsed ${valid.length} valid tags from ${parsed.length} total`);

      return valid;
    } catch (error) {
      console.error('[TagDetectionWorker] Failed to parse AI response:', error);
      return [];
    }
  }

  private async createTagAnnotation(
    resourceId: ResourceId,
    userId_: string,
    schemaId: string,
    tag: TagMatch
  ): Promise<void> {
    const eventStore = await createEventStore(this.config);
    const backendUrl = this.config.services.backend?.publicURL;

    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }

    const resourceUri = resourceIdToURI(resourceId, backendUrl);
    const annotationId = generateAnnotationId(backendUrl);

    // Create W3C-compliant annotation with dual-body structure:
    // 1. purpose: "tagging" with category value
    // 2. purpose: "classifying" with schema ID
    const annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      type: 'Annotation' as const,
      id: annotationId,
      motivation: 'tagging' as const,
      target: {
        type: 'SpecificResource' as const,
        source: resourceUri,
        selector: [
          {
            type: 'TextPositionSelector' as const,
            start: tag.start,
            end: tag.end
          },
          {
            type: 'TextQuoteSelector' as const,
            exact: tag.exact,
            prefix: tag.prefix || '',
            suffix: tag.suffix || ''
          }
        ]
      },
      body: [
        {
          type: 'TextualBody' as const,
          value: tag.category,
          purpose: 'tagging' as const,
          format: 'text/plain',
          language: 'en'
        },
        {
          type: 'TextualBody' as const,
          value: schemaId,
          purpose: 'classifying' as const,
          format: 'text/plain'
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

    console.log(`[TagDetectionWorker] Created tag annotation ${annotationId} for "${tag.category}": "${tag.exact.substring(0, 50)}..."`);
  }
}
