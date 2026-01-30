/**
 * Annotation CRUD Service
 *
 * Handles annotation creation, updates, and deletion
 * Orchestrates: ID generation + event emission + response building
 */

import type { EventStore } from '@semiont/event-sourcing';
import {
  type components,
  getTextPositionSelector,
  getTargetSource,
} from '@semiont/api-client';
import type {
  AnnotationAddedEvent,
  BodyOperation,
  EnvironmentConfig,
  ResourceId,
} from '@semiont/core';
import { annotationId, userId, uriToResourceId, uriToAnnotationId, userToAgent } from '@semiont/core';
import { generateAnnotationId } from '@semiont/event-sourcing';
import { AnnotationContext } from '@semiont/make-meaning';
import type { User } from '@prisma/client';

type Annotation = components['schemas']['Annotation'];
type CreateAnnotationRequest = components['schemas']['CreateAnnotationRequest'];
type CreateAnnotationResponse = components['schemas']['CreateAnnotationResponse'];
type UpdateAnnotationBodyRequest = components['schemas']['UpdateAnnotationBodyRequest'];
type UpdateAnnotationBodyResponse = components['schemas']['UpdateAnnotationBodyResponse'];

export class AnnotationCrudService {
  /**
   * Create a new annotation
   */
  static async createAnnotation(
    request: CreateAnnotationRequest,
    user: User,
    eventStore: EventStore,
    config: EnvironmentConfig
  ): Promise<CreateAnnotationResponse> {
    // Generate annotation ID
    const newAnnotationId = this.generateId(config);

    // Validate required fields
    this.validateCreateRequest(request);

    // Build annotation object
    const annotation = this.buildAnnotation(newAnnotationId, request);

    // Emit annotation.added event
    await this.emitAnnotationAdded(annotation, request.target.source, user, eventStore);

    // Build and return response
    return {
      annotation: {
        ...annotation,
        creator: userToAgent(user),
        created: new Date().toISOString(),
      },
    };
  }

  /**
   * Update annotation body with operations (add/remove/replace)
   */
  static async updateAnnotationBody(
    id: string,
    request: UpdateAnnotationBodyRequest,
    user: User,
    eventStore: EventStore,
    config: EnvironmentConfig
  ): Promise<UpdateAnnotationBodyResponse> {
    // Get annotation from view storage
    const annotation = await AnnotationContext.getAnnotation(
      annotationId(id),
      uriToResourceId(request.resourceId) as ResourceId,
      config
    );

    if (!annotation) {
      throw new Error('Annotation not found');
    }

    // Emit annotation.body.updated event
    await this.emitBodyUpdated(id, annotation, request.operations, user, eventStore);

    // Apply operations optimistically for response
    const updatedBody = this.applyBodyOperations(annotation.body, request.operations);

    return {
      annotation: {
        ...annotation,
        body: updatedBody,
      },
    };
  }

  /**
   * Delete an annotation
   */
  static async deleteAnnotation(
    id: string,
    resourceIdUri: string,
    user: User,
    eventStore: EventStore,
    config: EnvironmentConfig
  ): Promise<void> {
    const resourceId = uriToResourceId(resourceIdUri);

    // Verify annotation exists
    const projection = await AnnotationContext.getResourceAnnotations(resourceId, config);
    const annotation = projection.annotations.find((a: Annotation) => a.id === id);

    if (!annotation) {
      throw new Error('Annotation not found in resource');
    }

    // Emit annotation.removed event
    await this.emitAnnotationRemoved(id, resourceId, user, eventStore);
  }

  /**
   * Generate annotation ID
   */
  private static generateId(config: EnvironmentConfig): string {
    const backendUrl = config.services.backend?.publicURL;
    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }
    return generateAnnotationId(backendUrl);
  }

  /**
   * Validate create annotation request
   */
  private static validateCreateRequest(request: CreateAnnotationRequest): void {
    const posSelector = getTextPositionSelector(request.target.selector);
    if (!posSelector) {
      throw new Error('TextPositionSelector required for creating annotations');
    }

    if (!request.motivation) {
      throw new Error('motivation is required');
    }
  }

  /**
   * Build annotation object
   */
  private static buildAnnotation(
    id: string,
    request: CreateAnnotationRequest
  ): Omit<Annotation, 'creator' | 'created'> {
    return {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id,
      motivation: request.motivation,
      target: request.target,
      body: request.body as Annotation['body'],
      modified: new Date().toISOString(),
    };
  }

  /**
   * Emit annotation.added event
   */
  private static async emitAnnotationAdded(
    annotation: Omit<Annotation, 'creator' | 'created'>,
    targetSource: string,
    user: User,
    eventStore: EventStore
  ): Promise<void> {
    const eventPayload: Omit<AnnotationAddedEvent, 'id' | 'timestamp'> = {
      type: 'annotation.added',
      resourceId: uriToResourceId(targetSource),
      userId: userId(user.id),
      version: 1,
      payload: {
        annotation,
      },
    };
    await eventStore.appendEvent(eventPayload);
  }

  /**
   * Emit annotation.body.updated event
   */
  private static async emitBodyUpdated(
    id: string,
    annotation: Annotation,
    operations: UpdateAnnotationBodyRequest['operations'],
    user: User,
    eventStore: EventStore
  ): Promise<void> {
    await eventStore.appendEvent({
      type: 'annotation.body.updated',
      resourceId: uriToResourceId(getTargetSource(annotation.target)),
      userId: userId(user.id),
      version: 1,
      payload: {
        annotationId: annotationId(id),
        operations: operations as BodyOperation[],
      },
    });
  }

  /**
   * Emit annotation.removed event
   */
  private static async emitAnnotationRemoved(
    id: string,
    resourceId: ResourceId,
    user: User,
    eventStore: EventStore
  ): Promise<void> {
    console.log('[DeleteAnnotation] Emitting annotation.removed event for:', id);
    const storedEvent = await eventStore.appendEvent({
      type: 'annotation.removed',
      resourceId,
      userId: userId(user.id),
      version: 1,
      payload: {
        annotationId: uriToAnnotationId(id),
      },
    });
    console.log('[DeleteAnnotation] Event emitted, sequence:', storedEvent.metadata.sequenceNumber);
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
        // Add item (idempotent - don't add if already exists)
        const exists = bodyArray.some(item =>
          JSON.stringify(item) === JSON.stringify(op.item)
        );
        if (!exists) {
          bodyArray.push(op.item);
        }
      } else if (op.op === 'remove') {
        // Remove item
        const index = bodyArray.findIndex(item =>
          JSON.stringify(item) === JSON.stringify(op.item)
        );
        if (index !== -1) {
          bodyArray.splice(index, 1);
        }
      } else if (op.op === 'replace') {
        // Replace item
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
