/**
 * Resource Operations
 *
 * Business logic for resource operations including:
 * - Resource creation (ID generation, content storage, event emission)
 * - Archive/unarchive operations
 * - Entity type tagging (add/remove)
 * - Computing diffs and emitting appropriate events
 */

import type { EventStore } from '@semiont/event-sourcing';
import type { RepresentationStore } from '@semiont/content';
import type { components } from '@semiont/api-client';
import {
  CREATION_METHODS,
  type CreationMethod,
  generateUuid,
  resourceId,
  type UserId,
  type ResourceId,
  type EnvironmentConfig,
} from '@semiont/core';

type CreateResourceResponse = components['schemas']['CreateResourceResponse'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
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
   * Create a new resource
   * Orchestrates: content storage → event emission → response building
   */
  static async createResource(
    input: CreateResourceInput,
    userId: UserId,
    eventStore: EventStore,
    repStore: RepresentationStore,
    config: EnvironmentConfig
  ): Promise<CreateResourceResponse> {
    // Generate resource ID
    const rId = resourceId(generateUuid());

    // Store content
    const storedRep = await repStore.store(input.content, {
      mediaType: input.format,
      language: input.language || undefined,
      rel: 'original',
    });

    // Validate creation method
    const validCreationMethods = Object.values(CREATION_METHODS) as string[];
    const validatedCreationMethod = input.creationMethod && validCreationMethods.includes(input.creationMethod)
      ? (input.creationMethod as CreationMethod)
      : CREATION_METHODS.API;

    // Emit resource.created event
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: rId,
      userId,
      version: 1,
      payload: {
        name: input.name,
        format: input.format,
        contentChecksum: storedRep.checksum,
        contentByteSize: storedRep.byteSize,
        creationMethod: validatedCreationMethod,
        entityTypes: input.entityTypes || [],
        language: input.language || undefined,
        isDraft: false,
        generatedFrom: undefined,
        generationPrompt: undefined,
      },
    });

    // Build and return response
    const backendUrl = config.services.backend?.publicURL;
    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }
    const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;

    const resourceMetadata: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': `${normalizedBase}/resources/${rId}`,
      name: input.name,
      archived: false,
      entityTypes: input.entityTypes || [],
      creationMethod: validatedCreationMethod,
      dateCreated: new Date().toISOString(),
      representations: [
        {
          mediaType: storedRep.mediaType,
          checksum: storedRep.checksum,
          byteSize: storedRep.byteSize,
          rel: 'original',
          language: storedRep.language,
        },
      ],
    };

    return {
      resource: resourceMetadata,
      annotations: [],
    };
  }

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
