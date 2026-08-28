/**
 * Annotation Operations
 *
 * Business logic for annotation CRUD operations. All writes go through the
 * EventBus — the Stower actor subscribes and handles persistence.
 *
 * In-process callers pass a `UserId` to these operations; the
 * EventBus emits stamp it onto the gateway-injection field `_userId`,
 * matching the wire-side convention so Stower handlers see one shape
 * regardless of where the command originated.
 */

import type { components } from '@semiont/core';
import type {
  BodyOperation,
  UserId,
  Logger,
} from '@semiont/core';
import { EventBus, annotationId, resourceId as makeResourceId, assembleAnnotation, applyBodyOperations, isAnnotatable, getPrimaryRepresentation } from '@semiont/core';
import { AnnotationContext } from './annotation-context';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { KnowledgeBase } from './knowledge-base';

type Agent = components['schemas']['Agent'];
import type { Annotation } from '@semiont/core';
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];

/**
 * Refuse a write whose target cannot carry a coordinate (MEDIA-CAPABILITY-DISPATCH
 * D6/D8). Exported so the `mark:create-request` handler and this class share ONE
 * implementation rather than each deciding it — the registry stays the single
 * fact, and this is the single refusal built on it.
 *
 * Two populations land here: a registry row that declines (storage tier) and a
 * type the registry has never seen (import leniency keeps those in the KB, and
 * `textExtractionOf` is lenient for `text/*`, so they embed and turn up in
 * search). The wording states what cannot be done rather than making a
 * vocabulary claim the registry is not entitled to make about a miss.
 *
 * NOT applied to import or replay: those emit `mark:create` directly and never
 * reach either caller. That topology is D6's leniency — no flag, no bypass.
 */
export async function assertAnnotatableTarget(kb: { views: Pick<ViewStorage, 'get'> }, target: string): Promise<void> {
  const view = await kb.views.get(makeResourceId(target));
  const mediaType = getPrimaryRepresentation(view?.resource)?.mediaType;
  if (!mediaType || !isAnnotatable(mediaType)) {
    throw new Error(`"${mediaType ?? 'unknown'}" cannot be annotated`);
  }
}

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
    kb: KnowledgeBase,
  ): Promise<CreateAnnotationResult> {
    // This facade reaches `mark:create` directly, so without this it would be a
    // published way around the handler's gate (MEDIA-CAPABILITY-DISPATCH D6).
    await assertAnnotatableTarget(kb, request.target.source);

    const { annotation } = assembleAnnotation(request, creator);
    const resId = makeResourceId(request.target.source);

    // Emit mark:create — Stower subscribes and appends to event store
    eventBus.get('mark:create').next({
      annotation,
      _userId: userId,
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
      _userId: userId,
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
      _userId: userId,
      resourceId: resId,
    });

    logger?.debug('Annotation delete event emitted');
  }
}
