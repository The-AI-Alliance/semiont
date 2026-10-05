/**
 * Annotation Context
 *
 * Annotations as the record holds them: read from view storage, with the
 * text around one read from the content store. What needs the graph, the
 * vectors or a model is `AnnotationGather`.
 */

import { getTargetSource, getTargetSelector, getTextPositionSelector } from '@semiont/core';
import type { components, Annotation, ResourceId, ResourceAnnotations, AnnotationId } from '@semiont/core';
import { ResourceContext } from './resource-context';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { ContentReads } from '@semiont/content';
import type { AnchoredTextAsk } from './anchored-text-ask.js';

/** The view slice the annotation reads run on. */
type ViewGet = { views: Pick<ViewStorage, 'get'> };

type AnnotationContextResponse = components['schemas']['AnnotationContextResponse'];

export interface AnnotationTextContext {
  before: string;
  selected: string;
  after: string;
}

export class AnnotationContext {
  /**
   * Get resource annotations from view storage (fast path)
   * Throws if view missing
   */
  static async getResourceAnnotations(resourceId: ResourceId, kb: ViewGet): Promise<ResourceAnnotations> {
    const view = await kb.views.get(resourceId);

    if (!view) {
      throw new Error(`Resource ${resourceId} not found in view storage`);
    }

    return view.annotations;
  }

  /**
   * Get all annotations
   * @returns Array of all annotation objects
   */
  static async getAllAnnotations(resourceId: ResourceId, kb: ViewGet): Promise<Annotation[]> {
    const annotations = await this.getResourceAnnotations(resourceId, kb);
    return annotations.annotations;
  }

  /**
   * Get resource stats (version info)
   * @returns Version and timestamp info for the annotations
   */
  static async getResourceStats(resourceId: ResourceId, kb: ViewGet): Promise<{
    resourceId: ResourceId;
    version: number;
    updatedAt: string;
  }> {
    const annotations = await this.getResourceAnnotations(resourceId, kb);
    return {
      resourceId: annotations.resourceId,
      version: annotations.version,
      updatedAt: annotations.updatedAt,
    };
  }

  /**
   * Check if resource exists in view storage
   */
  static async resourceExists(resourceId: ResourceId, kb: { views: Pick<ViewStorage, 'exists'> }): Promise<boolean> {
    return kb.views.exists(resourceId);
  }

  /**
   * Get a single annotation by ID
   * O(1) lookup using resource ID to access view storage
   */
  static async getAnnotation(annotationId: AnnotationId, resourceId: ResourceId, kb: ViewGet): Promise<Annotation | null> {
    const annotations = await this.getResourceAnnotations(resourceId, kb);
    return annotations.annotations.find((a: Annotation) => a.id === annotationId) || null;
  }

  /**
   * Get annotation context (selected text with surrounding context)
   */
  static async getAnnotationContext(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    contextBefore: number,
    contextAfter: number,
    kb: ViewGet & { content: ContentReads; anchoredText: AnchoredTextAsk }
  ): Promise<AnnotationContextResponse> {
    // Get annotation from view storage
    const annotation = await this.getAnnotation(annotationId, resourceId, kb);
    if (!annotation) {
      throw new Error('Annotation not found');
    }

    // Get resource metadata from view storage
    const resource = await ResourceContext.getResourceMetadata(
      getTargetSource(annotation.target),
      kb
    );
    if (!resource) {
      throw new Error('Resource not found');
    }

    const contentStr = await ResourceContext.getResourceContent(resource, kb);
    if (contentStr === undefined) {
      throw new Error('Resource content not found: no text for this media (not decoded, and no derived text yet)');
    }

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
        wasAttributedTo: resource.wasAttributedTo,
        dateCreated: resource.dateCreated,
      },
    };
  }

  /**
   * Extract annotation context from resource content
   */
  static extractAnnotationContext(
    annotation: Annotation,
    contentStr: string,
    contextBefore: number,
    contextAfter: number
  ): AnnotationTextContext {
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
}
