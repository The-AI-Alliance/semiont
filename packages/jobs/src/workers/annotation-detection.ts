/**
 * Annotation Detection
 *
 * Orchestrates the full annotation detection pipeline:
 * 1. Build AI prompts using MotivationPrompts
 * 2. Call AI inference
 * 3. Parse and validate results using MotivationParsers
 *
 * All methods take content as a string parameter.
 * Workers are responsible for fetching content via ContentFetcher.
 */

import type { InferenceClient } from '@semiont/inference';
import { MotivationPrompts } from './detection/motivation-prompts';
import {
  MotivationParsers,
  type CommentMatch,
  type HighlightMatch,
  type AssessmentMatch,
  type TagMatch,
} from './detection/motivation-parsers';
import { getTagSchema, getSchemaCategory } from '@semiont/ontology';
import type { ResourceId } from '@semiont/core';
import type { ContentFetcher } from '../types';

export class AnnotationDetection {

  /**
   * Fetch content from a ContentFetcher and read the stream to a string.
   * Shared helper for all workers.
   */
  static async fetchContent(contentFetcher: ContentFetcher, resourceId: ResourceId): Promise<string> {
    const stream = await contentFetcher(resourceId);
    if (!stream) {
      throw new Error(`Could not load content for resource ${resourceId}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  /**
   * Detect comments in content
   */
  static async detectComments(
    content: string,
    client: InferenceClient,
    instructions?: string,
    tone?: string,
    density?: number
  ): Promise<CommentMatch[]> {
    const prompt = MotivationPrompts.buildCommentPrompt(content, instructions, tone, density);
    const response = await client.generateText(prompt, 3000, 0.4);
    return MotivationParsers.parseComments(response, content);
  }

  /**
   * Detect highlights in content
   */
  static async detectHighlights(
    content: string,
    client: InferenceClient,
    instructions?: string,
    density?: number
  ): Promise<HighlightMatch[]> {
    const prompt = MotivationPrompts.buildHighlightPrompt(content, instructions, density);
    const response = await client.generateText(prompt, 2000, 0.3);
    return MotivationParsers.parseHighlights(response, content);
  }

  /**
   * Detect assessments in content
   */
  static async detectAssessments(
    content: string,
    client: InferenceClient,
    instructions?: string,
    tone?: string,
    density?: number
  ): Promise<AssessmentMatch[]> {
    const prompt = MotivationPrompts.buildAssessmentPrompt(content, instructions, tone, density);
    const response = await client.generateText(prompt, 3000, 0.3);
    return MotivationParsers.parseAssessments(response, content);
  }

  /**
   * Detect tags in content for a specific category
   */
  static async detectTags(
    content: string,
    client: InferenceClient,
    schemaId: string,
    category: string
  ): Promise<TagMatch[]> {
    const schema = getTagSchema(schemaId);
    if (!schema) {
      throw new Error(`Invalid tag schema: ${schemaId}`);
    }

    const categoryInfo = getSchemaCategory(schemaId, category);
    if (!categoryInfo) {
      throw new Error(`Invalid category "${category}" for schema ${schemaId}`);
    }

    const prompt = MotivationPrompts.buildTagPrompt(
      content,
      category,
      schema.name,
      schema.description,
      schema.domain,
      categoryInfo.description,
      categoryInfo.examples
    );

    const response = await client.generateText(prompt, 4000, 0.2);
    const parsedTags = MotivationParsers.parseTags(response);
    return MotivationParsers.validateTagOffsets(parsedTags, content, category);
  }
}
