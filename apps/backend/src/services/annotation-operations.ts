/**
 * Annotation Operations Service
 *
 * Handles annotation context extraction and summary generation
 * Orchestrates: annotation queries + resource queries + content retrieval + LLM operations
 */

import { generateText } from '@semiont/inference';
import {
  getTargetSource,
  getTargetSelector,
  type components,
  getTextPositionSelector,
  getPrimaryRepresentation,
  decodeRepresentation,
} from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';
import { uriToResourceId, type AnnotationId, type ResourceId, type EnvironmentConfig } from '@semiont/core';
import { FilesystemRepresentationStore } from '@semiont/content';
import { AnnotationQueryService } from './annotation-queries';
import { ResourceQueryService } from './resource-queries';

type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type AnnotationContextResponse = components['schemas']['AnnotationContextResponse'];
type ContextualSummaryResponse = components['schemas']['ContextualSummaryResponse'];

interface AnnotationContext {
  before: string;
  selected: string;
  after: string;
}

export class AnnotationOperations {
  /**
   * Get annotation context (selected text with surrounding context)
   */
  static async getAnnotationContext(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    contextBefore: number,
    contextAfter: number,
    config: EnvironmentConfig
  ): Promise<AnnotationContextResponse> {
    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    // Get annotation from view storage
    const annotation = await AnnotationQueryService.getAnnotation(annotationId, resourceId, config);
    if (!annotation) {
      throw new Error('Annotation not found');
    }

    // Get resource metadata from view storage
    const resource = await ResourceQueryService.getResourceMetadata(
      uriToResourceId(getTargetSource(annotation.target)),
      config
    );
    if (!resource) {
      throw new Error('Resource not found');
    }

    // Get content from representation store
    const contentStr = await this.getResourceContent(resource, repStore);

    // Extract context based on annotation position
    const context = this.extractAnnotationContext(annotation, contentStr, contextBefore, contextAfter);

    return {
      annotation: annotation,
      context,
      resource: {
        '@context': resource['@context'],
        '@id': resource['@id'],
        name: resource.name,
        entityTypes: resource.entityTypes,
        representations: resource.representations,
        archived: resource.archived,
        creationMethod: resource.creationMethod,
        wasAttributedTo: resource.wasAttributedTo,
        dateCreated: resource.dateCreated,
      },
    };
  }

  /**
   * Generate AI summary of annotation in context
   */
  static async generateAnnotationSummary(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    config: EnvironmentConfig
  ): Promise<ContextualSummaryResponse> {
    const basePath = config.services.filesystem!.path;
    const projectRoot = config._metadata?.projectRoot;
    const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

    // Get annotation from view storage
    const annotation = await AnnotationQueryService.getAnnotation(annotationId, resourceId, config);
    if (!annotation) {
      throw new Error('Annotation not found');
    }

    // Get resource from view storage
    const resource = await ResourceQueryService.getResourceMetadata(
      uriToResourceId(getTargetSource(annotation.target)),
      config
    );
    if (!resource) {
      throw new Error('Resource not found');
    }

    // Get content from representation store
    const contentStr = await this.getResourceContent(resource, repStore);

    // Extract annotation text with context (fixed 500 chars for summary)
    const contextSize = 500;
    const context = this.extractAnnotationContext(annotation, contentStr, contextSize, contextSize);

    // Extract entity types from annotation body
    const annotationEntityTypes = getEntityTypes(annotation);

    // Generate summary using LLM
    const summary = await this.generateSummary(resource, context, annotationEntityTypes, config);

    return {
      summary,
      relevantFields: {
        resourceId: resource.id,
        resourceName: resource.name,
        entityTypes: annotationEntityTypes,
      },
      context: {
        before: context.before.substring(Math.max(0, context.before.length - 200)), // Last 200 chars
        selected: context.selected,
        after: context.after.substring(0, 200), // First 200 chars
      },
    };
  }

  /**
   * Get resource content as string
   */
  private static async getResourceContent(
    resource: ResourceDescriptor,
    repStore: FilesystemRepresentationStore
  ): Promise<string> {
    const primaryRep = getPrimaryRepresentation(resource);
    if (!primaryRep?.checksum || !primaryRep?.mediaType) {
      throw new Error('Resource content not found');
    }
    const content = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
    return decodeRepresentation(content, primaryRep.mediaType);
  }

  /**
   * Extract annotation context from resource content
   */
  private static extractAnnotationContext(
    annotation: Annotation,
    contentStr: string,
    contextBefore: number,
    contextAfter: number
  ): AnnotationContext {
    const targetSelector = getTargetSelector(annotation.target);
    const posSelector = targetSelector ? getTextPositionSelector(targetSelector) : null;
    if (!posSelector) {
      throw new Error('TextPositionSelector required for context');
    }

    const selStart = posSelector.start;
    const selEnd = posSelector.end;
    const start = Math.max(0, selStart - contextBefore);
    const end = Math.min(contentStr.length, selEnd + contextAfter);

    return {
      before: contentStr.substring(start, selStart),
      selected: contentStr.substring(selStart, selEnd),
      after: contentStr.substring(selEnd, end),
    };
  }

  /**
   * Generate LLM summary of annotation in context
   */
  private static async generateSummary(
    resource: ResourceDescriptor,
    context: AnnotationContext,
    entityTypes: string[],
    config: EnvironmentConfig
  ): Promise<string> {
    const summaryPrompt = `Summarize this text in context:

Context before: "${context.before.substring(Math.max(0, context.before.length - 200))}"
Selected exact: "${context.selected}"
Context after: "${context.after.substring(0, 200)}"

Resource: ${resource.name}
Entity types: ${entityTypes.join(', ')}`;

    return await generateText(summaryPrompt, config, 500, 0.5);
  }
}
