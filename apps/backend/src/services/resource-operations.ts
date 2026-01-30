/**
 * Resource Operations Service
 *
 * Handles resource creation, cloning, and other write operations.
 * Orchestrates: content storage + event sourcing + graph consumer subscription
 */

import {
  CREATION_METHODS,
  type CreationMethod,
  generateUuid,
  resourceId,
  type UserId,
  type ResourceId,
  type EnvironmentConfig,
  userToAgent,
} from '@semiont/core';
import type { RepresentationStore } from '@semiont/content';
import type { EventStore } from '@semiont/event-sourcing';
import type { components } from '@semiont/api-client';
import type { User } from '@prisma/client';

type CreateResourceResponse = components['schemas']['CreateResourceResponse'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type ContentFormat = components['schemas']['ContentFormat'];

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
   * Orchestrates: content storage → graph consumer subscription → event emission → response building
   */
  static async createResource(
    input: CreateResourceInput,
    user: User,
    eventStore: EventStore,
    repStore: RepresentationStore,
    config: EnvironmentConfig
  ): Promise<CreateResourceResponse> {
    // Generate resource ID
    const rId = resourceId(generateUuid());

    // Store content
    const storedRep = await this.storeContent(input.content, input.format, input.language, repStore);

    // Validate creation method
    const validatedCreationMethod = this.validateCreationMethod(input.creationMethod);

    // Emit resource.created event
    await this.emitResourceCreated(
      rId,
      user,
      input.name,
      input.format,
      input.entityTypes || [],
      input.language,
      storedRep,
      validatedCreationMethod,
      eventStore
    );

    // Build and return response
    return this.buildResourceResponse(
      rId,
      input.name,
      input.entityTypes || [],
      validatedCreationMethod,
      storedRep,
      user,
      config
    );
  }

  /**
   * Store content to content-addressed storage
   */
  private static async storeContent(
    content: Buffer,
    format: ContentFormat,
    language: string | undefined,
    repStore: RepresentationStore
  ) {
    return await repStore.store(content, {
      mediaType: format,
      language: language || undefined,
      rel: 'original',
    });
  }


  /**
   * Validate creation method or use default
   */
  private static validateCreationMethod(creationMethod?: string): CreationMethod {
    const validCreationMethods = Object.values(CREATION_METHODS) as string[];
    return creationMethod && validCreationMethods.includes(creationMethod)
      ? (creationMethod as CreationMethod)
      : CREATION_METHODS.API;
  }

  /**
   * Emit resource.created event to event store
   */
  private static async emitResourceCreated(
    resourceId: ResourceId,
    user: User,
    name: string,
    format: ContentFormat,
    entityTypes: string[],
    language: string | undefined,
    storedRep: { checksum: string; byteSize: number },
    creationMethod: CreationMethod,
    eventStore: EventStore
  ): Promise<void> {
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId,
      userId: user.id as UserId,
      version: 1,
      payload: {
        name,
        format,
        contentChecksum: storedRep.checksum,
        contentByteSize: storedRep.byteSize,
        creationMethod,
        entityTypes,
        language: language || undefined,
        isDraft: false,
        generatedFrom: undefined,
        generationPrompt: undefined,
      },
    });
  }

  /**
   * Build CreateResourceResponse with W3C-compliant metadata
   */
  private static buildResourceResponse(
    resourceId: ResourceId,
    name: string,
    entityTypes: string[],
    creationMethod: CreationMethod,
    storedRep: { checksum: string; byteSize: number; mediaType: string; language?: string },
    user: User,
    config: EnvironmentConfig
  ): CreateResourceResponse {
    const backendUrl = config.services.backend?.publicURL;
    if (!backendUrl) {
      throw new Error('Backend publicURL not configured');
    }
    const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;

    const resourceMetadata: ResourceDescriptor = {
      '@context': 'https://schema.org/',
      '@id': `${normalizedBase}/resources/${resourceId}`,
      name,
      archived: false,
      entityTypes,
      creationMethod,
      dateCreated: new Date().toISOString(),
      wasAttributedTo: userToAgent(user),
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
}
