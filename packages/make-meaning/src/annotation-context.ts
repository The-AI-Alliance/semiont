/**
 * Annotation Context
 *
 * Annotations as the record holds them, read from view storage, and the
 * text around one cut from its resource's content. What needs the graph, the
 * vectors or a model is `AnnotationGather`.
 */

import { getTargetSelector, getTextPositionSelector, textOffsets } from '@semiont/core';
import type { Annotation, ResourceId, ResourceAnnotations, AnnotationId } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';

/** The view slice the annotation reads run on. */
type ViewGet = { views: Pick<ViewStorage, 'get'> };

export interface AnnotationTextContext {
  before: string;
  selected: string;
  after: string;
}

/**
 * A span of a content, and the content on either side of it.
 *
 * `start` and `end` are offsets: they count Unicode code points from the
 * start of the content, as a `TextPositionSelector` does. `before` and `after`
 * say how much to take on each side, and count code points too. A JavaScript
 * string is indexed in UTF-16 code units, so each offset is converted where
 * the string is cut.
 */
export function textAround(content: string, start: number, end: number, before: number, after: number): AnnotationTextContext {
  const offsets = textOffsets(content);
  const cut = (from: number, to: number): string =>
    content.slice(offsets.indexAt(Math.max(0, from)), offsets.indexAt(Math.min(offsets.length, to)));
  return {
    before: cut(start - before, start),
    selected: cut(start, end),
    after: cut(end, end + after),
  };
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

    return textAround(contentStr, posSelector.start, posSelector.end, contextBefore, contextAfter);
  }
}
