import type { Annotation } from '@semiont/core';
import { isHighlight, isComment, isAssessment, isReference, isTag } from '@semiont/core';
import type { AnnotationsCollection } from '../types/annotation-props';

/**
 * Bucket a flat annotation list into an `AnnotationsCollection` by motivation.
 * Shared by the composite page state unit and the standalone `useResourceLoader`
 * so the grouping lives in exactly one place.
 */
export function groupAnnotations(annotations: Annotation[]): AnnotationsCollection {
  const groups: AnnotationsCollection = { highlights: [], references: [], assessments: [], comments: [], tags: [] };
  for (const ann of annotations) {
    if (isHighlight(ann)) groups.highlights.push(ann);
    else if (isComment(ann)) groups.comments.push(ann);
    else if (isAssessment(ann)) groups.assessments.push(ann);
    else if (isReference(ann)) groups.references.push(ann);
    else if (isTag(ann)) groups.tags.push(ann);
  }
  return groups;
}
