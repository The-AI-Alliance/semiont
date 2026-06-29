/**
 * Resource Operations
 *
 * Business logic for resource operations. All writes go through the EventBus
 * — the Stower actor subscribes and handles persistence.
 *
 * For create: emits yield:create, awaits yield:create-ok / yield:create-failed.
 */

import type {
  UserId,
  ResourceId,
} from '@semiont/core';
import type { components } from '@semiont/core';
import { EventBus, resourceId as makeResourceId, busRequest } from '@semiont/core';
import { asBusRequestPrimitive } from './bus-request-local';

type ContentFormat = components['schemas']['ContentFormat'];
type Agent = components['schemas']['Agent'];

export interface CreateResourceInput {
  name: string;
  storageUri: string;
  contentChecksum: string;
  byteSize: number;
  format: ContentFormat;
  language?: string;
  entityTypes?: string[];
  /** Provenance for AI-generated resources: source resource + annotation. */
  generatedFrom?: { resourceId?: string; annotationId?: string };
  generationPrompt?: string;
  generator?: Agent | Agent[];
  isDraft?: boolean;
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
    // Confirmed in-process write over busRequest: the reply is matched by
    // correlationId, so concurrent creates can't cross-resolve (the old race()
    // took the first yield:create-ok on the channel regardless of which create
    // it answered). In-process callers stamp `_userId` directly, mirroring what
    // the gateway does for wire callers.
    const { resourceId: rId } = await busRequest<{ resourceId: string }>(
      asBusRequestPrimitive(eventBus),
      'yield:create',
      {
        name: input.name,
        storageUri: input.storageUri,
        contentChecksum: input.contentChecksum,
        byteSize: input.byteSize,
        format: input.format,
        _userId: userId,
        language: input.language,
        entityTypes: input.entityTypes,
        generatedFrom: input.generatedFrom,
        generationPrompt: input.generationPrompt,
        generator: input.generator,
        isDraft: input.isDraft,
      },
      30_000,
    );

    return makeResourceId(rId);
  }
}
