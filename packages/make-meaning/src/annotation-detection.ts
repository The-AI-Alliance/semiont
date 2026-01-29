/**
 * Annotation Detection
 *
 * Orchestrates the full annotation detection pipeline:
 * 1. Fetch resource metadata and content
 * 2. Build AI prompts using MotivationPrompts
 * 3. Call AI inference
 * 4. Parse and validate results using MotivationParsers
 *
 * This is the high-level API for AI-powered annotation detection.
 * Workers and other consumers should use these methods instead of
 * implementing detection logic directly.
 */

import { ResourceContext } from './resource-context';
import { FilesystemRepresentationStore } from '@semiont/content';
import { getPrimaryRepresentation, decodeRepresentation } from '@semiont/api-client';
import { getInferenceClient } from '@semiont/inference';
import { MotivationPrompts } from './detection/motivation-prompts';
import {
  MotivationParsers,
  type CommentMatch,
  type HighlightMatch,
  type AssessmentMatch,
  type TagMatch,
} from './detection/motivation-parsers';
import { getTagSchema, getSchemaCategory } from '@semiont/ontology';
import type { EnvironmentConfig, ResourceId } from '@semiont/core';

export class AnnotationDetection {
  /**
   * Detect comments in a resource
   *
   * @param resourceId - The resource to analyze
   * @param config - Environment configuration
   * @param instructions - Optional user instructions for comment generation
   * @param tone - Optional tone guidance (e.g., "academic", "conversational")
   * @param density - Optional target number of comments per 2000 words
   * @returns Array of validated comment matches
   */
  static async detectComments(
    resourceId: ResourceId,
    config: EnvironmentConfig,
    instructions?: string,
    tone?: string,
    density?: number
  ): Promise<CommentMatch[]> {
    // 1. Fetch resource metadata
    const resource = await ResourceContext.getResourceMetadata(resourceId, config);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found`);
    }

    // 2. Load content from representation store
    const content = await this.loadResourceContent(resourceId, config);
    if (!content) {
      throw new Error(`Could not load content for resource ${resourceId}`);
    }

    // 3. Build prompt
    const prompt = MotivationPrompts.buildCommentPrompt(content, instructions, tone, density);

    // 4. Call AI inference
    const client = await getInferenceClient(config);
    const response = await client.generateText(
      prompt,
      3000,  // maxTokens: Higher than highlights/assessments due to comment text
      0.4    // temperature: Slightly higher to allow creative context
    );

    // 5. Parse and validate response
    return MotivationParsers.parseComments(response, content);
  }

  /**
   * Detect highlights in a resource
   *
   * @param resourceId - The resource to analyze
   * @param config - Environment configuration
   * @param instructions - Optional user instructions for highlight selection
   * @param density - Optional target number of highlights per 2000 words
   * @returns Array of validated highlight matches
   */
  static async detectHighlights(
    resourceId: ResourceId,
    config: EnvironmentConfig,
    instructions?: string,
    density?: number
  ): Promise<HighlightMatch[]> {
    // 1. Fetch resource metadata
    const resource = await ResourceContext.getResourceMetadata(resourceId, config);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found`);
    }

    // 2. Load content from representation store
    const content = await this.loadResourceContent(resourceId, config);
    if (!content) {
      throw new Error(`Could not load content for resource ${resourceId}`);
    }

    // 3. Build prompt
    const prompt = MotivationPrompts.buildHighlightPrompt(content, instructions, density);

    // 4. Call AI inference
    const client = await getInferenceClient(config);
    const response = await client.generateText(
      prompt,
      2000,  // maxTokens: Lower than comments/assessments (no body text)
      0.3    // temperature: Low for consistent importance judgments
    );

    // 5. Parse and validate response
    return MotivationParsers.parseHighlights(response, content);
  }

  /**
   * Detect assessments in a resource
   *
   * @param resourceId - The resource to analyze
   * @param config - Environment configuration
   * @param instructions - Optional user instructions for assessment generation
   * @param tone - Optional tone guidance (e.g., "critical", "supportive")
   * @param density - Optional target number of assessments per 2000 words
   * @returns Array of validated assessment matches
   */
  static async detectAssessments(
    resourceId: ResourceId,
    config: EnvironmentConfig,
    instructions?: string,
    tone?: string,
    density?: number
  ): Promise<AssessmentMatch[]> {
    // 1. Fetch resource metadata
    const resource = await ResourceContext.getResourceMetadata(resourceId, config);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found`);
    }

    // 2. Load content from representation store
    const content = await this.loadResourceContent(resourceId, config);
    if (!content) {
      throw new Error(`Could not load content for resource ${resourceId}`);
    }

    // 3. Build prompt
    const prompt = MotivationPrompts.buildAssessmentPrompt(content, instructions, tone, density);

    // 4. Call AI inference
    const client = await getInferenceClient(config);
    const response = await client.generateText(
      prompt,
      3000,  // maxTokens: Higher for assessment text
      0.3    // temperature: Lower for analytical consistency
    );

    // 5. Parse and validate response
    return MotivationParsers.parseAssessments(response, content);
  }

  /**
   * Detect tags in a resource for a specific category
   *
   * @param resourceId - The resource to analyze
   * @param config - Environment configuration
   * @param schemaId - The tag schema identifier (e.g., "irac", "imrad")
   * @param category - The specific category to detect
   * @returns Array of validated tag matches
   */
  static async detectTags(
    resourceId: ResourceId,
    config: EnvironmentConfig,
    schemaId: string,
    category: string
  ): Promise<TagMatch[]> {
    // Validate schema and category
    const schema = getTagSchema(schemaId);
    if (!schema) {
      throw new Error(`Invalid tag schema: ${schemaId}`);
    }

    const categoryInfo = getSchemaCategory(schemaId, category);
    if (!categoryInfo) {
      throw new Error(`Invalid category "${category}" for schema ${schemaId}`);
    }

    // 1. Fetch resource metadata
    const resource = await ResourceContext.getResourceMetadata(resourceId, config);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found`);
    }

    // 2. Load content from representation store (FULL content for structural analysis)
    const content = await this.loadResourceContent(resourceId, config);
    if (!content) {
      throw new Error(`Could not load content for resource ${resourceId}`);
    }

    // 3. Build prompt with schema and category information
    const prompt = MotivationPrompts.buildTagPrompt(
      content,
      category,
      schema.name,
      schema.description,
      schema.domain,
      categoryInfo.description,
      categoryInfo.examples
    );

    // 4. Call AI inference
    const client = await getInferenceClient(config);
    const response = await client.generateText(
      prompt,
      4000,  // maxTokens: Higher for full document analysis
      0.2    // temperature: Lower for structural consistency
    );

    // 5. Parse response (without validation)
    const parsedTags = MotivationParsers.parseTags(response);

    // 6. Validate offsets and add category
    return MotivationParsers.validateTagOffsets(parsedTags, content, category);
  }

  /**
   * Load resource content from representation store
   * Helper method used by all detection methods
   *
   * @param resourceId - The resource ID to load
   * @param config - Environment configuration
   * @returns Resource content as string, or null if not available
   */
  private static async loadResourceContent(
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<string | null> {
    const resource = await ResourceContext.getResourceMetadata(resourceId, config);
    if (!resource) return null;

    const primaryRep = getPrimaryRepresentation(resource);
    if (!primaryRep) return null;

    // Only process text content
    const baseMediaType = primaryRep.mediaType?.split(';')[0]?.trim() || '';
    if (baseMediaType !== 'text/plain' && baseMediaType !== 'text/markdown') {
      return null;
    }

    if (!primaryRep.checksum || !primaryRep.mediaType) return null;

    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);
    const contentBuffer = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
    return decodeRepresentation(contentBuffer, primaryRep.mediaType);
  }
}
