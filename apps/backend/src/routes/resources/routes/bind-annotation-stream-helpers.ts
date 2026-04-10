/**
 * Helpers for bind-annotation-stream route.
 *
 * Pure functions over a KnowledgeBase, factored out so they can be unit-tested
 * without standing up the Hono request context.
 */

import { AnnotationContext } from '@semiont/make-meaning';
import type { KnowledgeBase } from '@semiont/make-meaning';
import type { ResourceId, components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

/**
 * Read the post-bind state of an annotation from the materialized view.
 *
 * Returns the annotation, or null if not present in the view (which after a
 * successful appendEvent indicates a real materialization bug — the route
 * should surface that as bind:failed).
 */
export async function readAnnotationFromView(
  kb: KnowledgeBase,
  resourceId: ResourceId,
  annotationId: string,
): Promise<Annotation | null> {
  const allAnnotations = await AnnotationContext.getAllAnnotations(resourceId, kb);
  return allAnnotations.find((a) => a.id === annotationId) ?? null;
}
