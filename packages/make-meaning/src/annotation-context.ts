/**
 * Annotation Context
 *
 * Annotations as the record holds them, read from view storage, and the
 * text around one cut from its resource's content. What needs the graph, the
 * vectors or a model is `AnnotationGather`.
 */

import { getTargetSelector, getTextPositionSelector } from '@semiont/core';
import type { Annotation, ResourceId, ResourceAnnotations, AnnotationId } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';

/** The view slice the annotation reads run on. */
type ViewGet = { views: Pick<ViewStorage, 'get'> };

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
   * Get a single annotation by ID
   * O(1) lookup using resource ID to access view storage
   */
  static async getAnnotation(annotationId: AnnotationId, resourceId: ResourceId, kb: ViewGet): Promise<Annotation | null> {
    const annotations = await this.getResourceAnnotations(resourceId, kb);
    return annotations.annotations.find((a: Annotation) => a.id === annotationId) || null;
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
