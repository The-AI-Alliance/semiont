import type { Annotation } from '@semiont/core';
import type { AnnotationsCollection } from '@semiont/react-ui';

/**
 * The detail click action hands us an annotation ID (`onOpenPanel`'s
 * `scrollToAnnotationId`); the loader hands us the resource's annotations already
 * grouped by motivation. Resolve the click to its annotation across all groups.
 */
export function findAnnotation(collection: AnnotationsCollection, id: string): Annotation | null {
  const groups = [
    collection.highlights,
    collection.references,
    collection.assessments,
    collection.comments,
    collection.tags,
  ];
  for (const group of groups) {
    const hit = group.find((a) => a.id === id);
    if (hit !== undefined) return hit;
  }
  return null;
}
