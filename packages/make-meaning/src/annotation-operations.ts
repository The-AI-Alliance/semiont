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

import { generateAnnotationId } from '@semiont/event-sourcing';
import type { components } from '@semiont/core';
import { getTextPositionSelector, getTargetSource } from '@semiont/api-client';
import type {
  BodyOperation,
  ResourceId,
  UserId,
  Logger,
} from '@semiont/core';
import { EventBus, annotationId, uriToResourceId, uriToAnnotationId } from '@semiont/core';
import { AnnotationContext } from './annotation-context';
import type { KnowledgeBase } from './knowledge-base';

type Agent = components['schemas']['Agent'];
type Annotation = components['schemas']['Annotation'];
type AnnotationBody = components['schemas']['AnnotationBody'];
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
    const newAnnotationId = generateAnnotationId(publicURL);

    const posSelector = getTextPositionSelector(request.target.selector);
    if (!posSelector) {
      throw new Error('TextPositionSelector required for creating annotations');
    }

    if (!request.motivation) {
      throw new Error('motivation is required');
    }

    const now = new Date().toISOString();
    const annotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id: newAnnotationId,
      motivation: request.motivation,
      target: request.target,
      body: request.body as Annotation['body'],
      creator,
      created: now,
      modified: now,
    };

    const resourceId = uriToResourceId(request.target.source);

    // Emit mark:create — Stower subscribes and appends to event store
    eventBus.get('mark:create').next({
      motivation: request.motivation,
      selector: request.target.selector,
      body: (Array.isArray(request.body) ? request.body : [request.body]) as AnnotationBody[],
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

    const updatedBody = this.applyBodyOperations(annotation.body, request.operations);

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

  /**
   * Apply body operations (add/remove/replace) to annotation body
   */
  private static applyBodyOperations(
    body: Annotation['body'],
    operations: UpdateAnnotationBodyRequest['operations']
  ): Annotation['body'] {
    const bodyArray = Array.isArray(body) ? [...body] : [];

    for (const op of operations) {
      if (op.op === 'add') {
        const exists = bodyArray.some(item =>
          JSON.stringify(item) === JSON.stringify(op.item)
        );
        if (!exists) {
          bodyArray.push(op.item);
        }
      } else if (op.op === 'remove') {
        const index = bodyArray.findIndex(item =>
          JSON.stringify(item) === JSON.stringify(op.item)
        );
        if (index !== -1) {
          bodyArray.splice(index, 1);
        }
      } else if (op.op === 'replace') {
        const index = bodyArray.findIndex(item =>
          JSON.stringify(item) === JSON.stringify(op.oldItem)
        );
        if (index !== -1) {
          bodyArray[index] = op.newItem;
        }
      }
    }

    return bodyArray;
  }
}
