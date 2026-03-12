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
import { getTargetSource } from '@semiont/api-client';
import type {
  BodyOperation,
  ResourceId,
  UserId,
  Logger,
} from '@semiont/core';
import { EventBus, annotationId, uriToResourceId, uriToAnnotationId } from '@semiont/core';
import { AnnotationContext } from './annotation-context';
import type { KnowledgeBase } from './knowledge-base';
import { assembleAnnotation, applyBodyOperations } from './annotation-assembly';

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
    publicURL: string
  ): Promise<CreateAnnotationResult> {
    const { annotation, bodyArray } = assembleAnnotation(request, creator, publicURL);
    const resourceId = uriToResourceId(request.target.source);

    // Emit mark:create — Stower subscribes and appends to event store
    eventBus.get('mark:create').next({
      motivation: request.motivation,
      selector: request.target.selector,
      body: bodyArray,
      userId,
      resourceId,
      annotation,
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
    const annotation = await AnnotationContext.getAnnotation(
      annotationId(id),
      uriToResourceId(request.resourceId) as ResourceId,
      kb
    );

    if (!annotation) {
      throw new Error('Annotation not found');
    }

    const resourceId = uriToResourceId(getTargetSource(annotation.target));

    // Emit mark:update-body — Stower subscribes and appends to event store
    eventBus.get('mark:update-body').next({
      annotationId: annotationId(id),
      userId,
      resourceId,
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
    resourceIdUri: string,
    userId: UserId,
    eventBus: EventBus,
    kb: KnowledgeBase,
    logger?: Logger
  ): Promise<void> {
    const resId = uriToResourceId(resourceIdUri);

    const projection = await AnnotationContext.getResourceAnnotations(resId, kb);
    const annotation = projection.annotations.find((a: Annotation) => a.id === id);

    if (!annotation) {
      throw new Error('Annotation not found in resource');
    }

    logger?.debug('Removing annotation via EventBus', { annotationId: id });

    // Emit mark:delete — Stower subscribes and appends to event store
    eventBus.get('mark:delete').next({
      annotationId: uriToAnnotationId(id),
      userId,
      resourceId: resId,
    });

    logger?.debug('Annotation delete event emitted');
  }
}
