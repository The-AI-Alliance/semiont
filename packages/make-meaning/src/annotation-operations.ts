/**
 * Annotation Operations
 *
 * Business logic for annotation CRUD operations:
 * - Create annotations (ID generation, validation, event emission)
 * - Update annotation body (operations: add/remove/replace)
 * - Delete annotations (validation, event emission)
 */

import type { EventStore } from '@semiont/event-sourcing';
import { generateAnnotationId } from '@semiont/event-sourcing';
import type { components } from '@semiont/core';
import { getTextPositionSelector, getTargetSource } from '@semiont/api-client';
import type {
  AnnotationAddedEvent,
  BodyOperation,
  EnvironmentConfig,
  ResourceId,
  UserId,
} from '@semiont/core';
import { annotationId, uriToResourceId, uriToAnnotationId } from '@semiont/core';
import { AnnotationContext } from './annotation-context';

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
   * Create a new annotation
   */
  static async createAnnotation(
    request: CreateAnnotationRequest,
    userId: UserId,
    eventStore: EventStore,
    config: EnvironmentConfig
  ): Promise<CreateAnnotationResult> {
    // Generate annotation ID
    const backendUrl = config.services.backend?.publicURL;
    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }
    const newAnnotationId = generateAnnotationId(backendUrl);

    // Validate required fields
    const posSelector = getTextPositionSelector(request.target.selector);
    if (!posSelector) {
      throw new Error('TextPositionSelector required for creating annotations');
    }

    if (!request.motivation) {
      throw new Error('motivation is required');
    }

    // Build annotation object
    const annotation: Annotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id: newAnnotationId,
      motivation: request.motivation,
      target: request.target,
      body: request.body as Annotation['body'],
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    };

    // Emit annotation.added event
    const eventPayload: Omit<AnnotationAddedEvent, 'id' | 'timestamp'> = {
      type: 'annotation.added',
      resourceId: uriToResourceId(request.target.source),
      userId,
      version: 1,
      payload: {
        annotation: {
          '@context': annotation['@context'],
          'type': annotation.type,
          id: annotation.id,
          motivation: annotation.motivation,
          target: annotation.target,
          body: annotation.body,
          modified: annotation.modified,
        },
      },
    };
    await eventStore.appendEvent(eventPayload);

    return { annotation };
  }

  /**
   * Update annotation body with operations (add/remove/replace)
   */
  static async updateAnnotationBody(
    id: string,
    request: UpdateAnnotationBodyRequest,
    userId: UserId,
    eventStore: EventStore,
    config: EnvironmentConfig
  ): Promise<UpdateAnnotationBodyResult> {
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
    await eventStore.appendEvent({
      type: 'annotation.body.updated',
      resourceId: uriToResourceId(getTargetSource(annotation.target)),
      userId,
      version: 1,
      payload: {
        annotationId: annotationId(id),
        operations: request.operations as BodyOperation[],
      },
    });

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
    userId: UserId,
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
    console.log('[AnnotationOperations] Emitting annotation.removed event for:', id);
    const storedEvent = await eventStore.appendEvent({
      type: 'annotation.removed',
      resourceId,
      userId,
      version: 1,
      payload: {
        annotationId: uriToAnnotationId(id),
      },
    });
    console.log('[AnnotationOperations] Event emitted, sequence:', storedEvent.metadata.sequenceNumber);
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
