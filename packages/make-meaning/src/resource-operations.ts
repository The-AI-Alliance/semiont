/**
 * Resource Operations
 *
 * Business logic for resource operations. All writes go through the EventBus
 * — the Stower actor subscribes and handles persistence.
 *
 * For create: emits yield:create, awaits yield:created / yield:create-failed.
 * For archive/unarchive: emits mark:archive / mark:unarchive on scoped bus.
 * For entity type updates: emits mark:update-entity-types.
 */

import { firstValueFrom, race, timer } from 'rxjs';
import { map, take } from 'rxjs/operators';
import type {
  CreationMethod,
  UserId,
  ResourceId,
} from '@semiont/core';
import type { components } from '@semiont/core';
import { EventBus } from '@semiont/core';

type ContentFormat = components['schemas']['ContentFormat'];

export interface UpdateResourceInput {
  resourceId: ResourceId;
  userId: UserId;
  currentArchived?: boolean;
  updatedArchived?: boolean;
  currentEntityTypes?: string[];
  updatedEntityTypes?: string[];
}

export interface CreateResourceInput {
  name: string;
  content: Buffer;
  format: ContentFormat;
  language?: string;
  entityTypes?: string[];
  creationMethod?: CreationMethod;
}

export class ResourceOperations {
  /**
   * Create a new resource via EventBus → Stower
   */
  static async createResource(
    input: CreateResourceInput,
    userId: UserId,
    eventBus: EventBus,
  ): Promise<ResourceId> {
    // Set up listeners before emitting
    const result$ = race(
      eventBus.get('yield:created').pipe(
        take(1),
        map((result) => ({ ok: true as const, result })),
      ),
      eventBus.get('yield:create-failed').pipe(
        take(1),
        map((failure) => ({ ok: false as const, error: failure.error })),
      ),
      timer(30_000).pipe(
        map(() => ({ ok: false as const, error: new Error('Resource creation timed out') })),
      ),
    );

    // Emit the command
    eventBus.get('yield:create').next({
      name: input.name,
      content: input.content,
      format: input.format,
      userId,
      language: input.language,
      entityTypes: input.entityTypes,
      creationMethod: input.creationMethod,
    });

    const outcome = await firstValueFrom(result$);
    if (!outcome.ok) {
      throw outcome.error;
    }

    return outcome.result.resourceId;
  }

  /**
   * Update resource metadata via EventBus → Stower
   */
  static async updateResource(
    input: UpdateResourceInput,
    eventBus: EventBus,
  ): Promise<void> {
    // Handle archived status change (emit on global bus with resourceId for Stower)
    if (input.updatedArchived !== undefined && input.updatedArchived !== input.currentArchived) {
      if (input.updatedArchived) {
        eventBus.get('mark:archive').next({ userId: input.userId, resourceId: input.resourceId });
      } else {
        eventBus.get('mark:unarchive').next({ userId: input.userId, resourceId: input.resourceId });
      }
    }

    // Handle entity type changes
    if (input.updatedEntityTypes && input.currentEntityTypes) {
      eventBus.get('mark:update-entity-types').next({
        resourceId: input.resourceId,
        userId: input.userId,
        currentEntityTypes: input.currentEntityTypes,
        updatedEntityTypes: input.updatedEntityTypes,
      });
    }
  }
}
