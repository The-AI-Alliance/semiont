/**
 * Resource Operations
 *
 * Business logic for resource updates including:
 * - Archive/unarchive operations
 * - Entity type tagging (add/remove)
 * - Computing diffs and emitting appropriate events
 */

import type { EventStore } from '@semiont/event-sourcing';
import type { ResourceId, UserId } from '@semiont/core';

export interface UpdateResourceInput {
  resourceId: ResourceId;
  userId: UserId;
  currentArchived?: boolean;
  updatedArchived?: boolean;
  currentEntityTypes?: string[];
  updatedEntityTypes?: string[];
}

export class ResourceOperations {
  /**
   * Update resource metadata by computing diffs and emitting events
   * Handles: archived status changes, entity type additions/removals
   */
  static async updateResource(
    input: UpdateResourceInput,
    eventStore: EventStore
  ): Promise<void> {
    // Handle archived status change
    if (input.updatedArchived !== undefined && input.updatedArchived !== input.currentArchived) {
      await this.updateArchivedStatus(
        input.resourceId,
        input.userId,
        input.updatedArchived,
        eventStore
      );
    }

    // Handle entity type changes
    if (input.updatedEntityTypes && input.currentEntityTypes) {
      await this.updateEntityTypes(
        input.resourceId,
        input.userId,
        input.currentEntityTypes,
        input.updatedEntityTypes,
        eventStore
      );
    }
  }

  /**
   * Update archived status by emitting resource.archived or resource.unarchived event
   */
  private static async updateArchivedStatus(
    resourceId: ResourceId,
    userId: UserId,
    archived: boolean,
    eventStore: EventStore
  ): Promise<void> {
    if (archived) {
      await eventStore.appendEvent({
        type: 'resource.archived',
        resourceId,
        userId,
        version: 1,
        payload: {
          reason: undefined,
        },
      });
    } else {
      await eventStore.appendEvent({
        type: 'resource.unarchived',
        resourceId,
        userId,
        version: 1,
        payload: {},
      });
    }
  }

  /**
   * Update entity types by computing diff and emitting events for added/removed types
   */
  private static async updateEntityTypes(
    resourceId: ResourceId,
    userId: UserId,
    currentEntityTypes: string[],
    updatedEntityTypes: string[],
    eventStore: EventStore
  ): Promise<void> {
    const diff = this.computeEntityTypeDiff(currentEntityTypes, updatedEntityTypes);

    // Emit entitytag.added for new types
    for (const entityType of diff.added) {
      await eventStore.appendEvent({
        type: 'entitytag.added',
        resourceId,
        userId,
        version: 1,
        payload: {
          entityType,
        },
      });
    }

    // Emit entitytag.removed for removed types
    for (const entityType of diff.removed) {
      await eventStore.appendEvent({
        type: 'entitytag.removed',
        resourceId,
        userId,
        version: 1,
        payload: {
          entityType,
        },
      });
    }
  }

  /**
   * Compute diff between current and updated entity types
   * Returns arrays of added and removed entity types
   */
  private static computeEntityTypeDiff(
    current: string[],
    updated: string[]
  ): { added: string[]; removed: string[] } {
    const added = updated.filter(et => !current.includes(et));
    const removed = current.filter(et => !updated.includes(et));
    return { added, removed };
  }
}
