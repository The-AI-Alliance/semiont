import { AnnotationContext } from './annotation-context';
import type { KnowledgeBase } from './knowledge-base';
import type { Annotation, ResourceId, StoredEvent } from '@semiont/core';

export function eventAnnotationId(event: StoredEvent): string | null {
  switch (event.type) {
    case 'mark:added':
      return event.payload.annotation.id;
    case 'mark:body-updated':
      return event.payload.annotationId;
    case 'mark:removed':
      return event.payload.annotationId;
    default:
      return null;
  }
}

export async function readAnnotationFromView(
  kb: KnowledgeBase,
  resourceId: ResourceId,
  annotationId: string,
): Promise<Annotation | null> {
  const allAnnotations = await AnnotationContext.getAllAnnotations(resourceId, kb);
  return allAnnotations.find((a) => a.id === annotationId) ?? null;
}
