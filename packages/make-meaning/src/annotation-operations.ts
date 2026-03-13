/**
 * Annotation Operations
 *
 * Business logic for annotation CRUD operations. All writes go through the
 * EventBus — the Stower actor subscribes and handles persistence.
 *
 * - Create: emits mark:create with full annotation + userId + resourceId
 * - Update body: emits mark:update-body
 * - Delete: emits mark:delete with annotationId + userId + resourceId
 */

import type { components } from '@semiont/core';
import type {
  BodyOperation,
  UserId,
  Logger,
} from '@semiont/core';
import { EventBus, annotationId, resourceId as makeResourceId, assembleAnnotation, applyBodyOperations } from '@semiont/core';
import { AnnotationContext } from './annotation-context';
import type { KnowledgeBase } from './knowledge-base';

type Agent = components['schemas']['Agent'];
type Annotation = components['schemas']['Annotation'];
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];

export interface CreateAnnotationResult {
  annotation: Annotation;
}

export interface UpdateAnnotationBodyResult {
  annotation: Annotation;
}

export class AnnotationOperations {
  /**
   * Create a new annotation via EventBus → Stower
   */
  static async createAnnotation(
    request: CreateAnnotationRequest,
    userId: UserId,
    creator: Agent,
    eventBus: EventBus,
  ): Promise<CreateAnnotationResult> {
    const { annotation } = assembleAnnotation(request, creator);
    const resId = makeResourceId(request.target.source);

    // Emit mark:create — Stower subscribes and appends to event store
    eventBus.get('mark:create').next({
      annotation,
      userId,
      resourceId: resId,
    });

    return { annotation };
  }

  /**
   * Update annotation body via EventBus → Stower
   */
  static async updateAnnotationBody(
    id: string,
    request: UpdateAnnotationBodyRequest,
    userId: UserId,
    eventBus: EventBus,
    kb: KnowledgeBase
  ): Promise<UpdateAnnotationBodyResult> {
    const resId = makeResourceId(request.resourceId);
    const annotation = await AnnotationContext.getAnnotation(
      annotationId(id),
      resId,
      kb
    );

    if (!annotation) {
      throw new Error('Annotation not found');
    }

    // Emit mark:update-body — Stower subscribes and appends to event store
    eventBus.get('mark:update-body').next({
      annotationId: annotationId(id),
      userId,
      resourceId: resId,
      operations: request.operations as BodyOperation[],
    });

    const updatedBody = applyBodyOperations(annotation.body, request.operations);

    return {
      annotation: {
        ...annotation,
        body: updatedBody,
      },
    };
  }

  /**
   * Delete an annotation via EventBus → Stower
   */
  static async deleteAnnotation(
    id: string,
    resourceIdStr: string,
    userId: UserId,
    eventBus: EventBus,
    kb: KnowledgeBase,
    logger?: Logger
  ): Promise<void> {
    const resId = makeResourceId(resourceIdStr);

    const projection = await AnnotationContext.getResourceAnnotations(resId, kb);
    const annotation = projection.annotations.find((a: Annotation) => a.id === id);

    if (!annotation) {
      throw new Error('Annotation not found in resource');
    }

    logger?.debug('Removing annotation via EventBus', { annotationId: id });

    // Emit mark:delete — Stower subscribes and appends to event store
    eventBus.get('mark:delete').next({
      annotationId: annotationId(id),
      userId,
      resourceId: resId,
    });

    logger?.debug('Annotation delete event emitted');
  }
}
