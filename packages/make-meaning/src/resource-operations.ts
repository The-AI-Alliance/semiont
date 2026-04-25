/**
 * Resource Operations
 *
 * Business logic for resource operations. All writes go through the EventBus
 * — the Stower actor subscribes and handles persistence.
 *
 * For create: emits yield:create, awaits yield:created / yield:create-failed.
 */

import { firstValueFrom, race, timer } from 'rxjs';
import { map, take } from 'rxjs/operators';
import type {
  CreationMethod,
  UserId,
  ResourceId,
} from '@semiont/core';
import type { components } from '@semiont/core';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';

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
  creationMethod?: CreationMethod;
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
    // Set up listeners before emitting
    const result$ = race(
      eventBus.get('yield:create-ok').pipe(
        take(1),
        map((result) => ({ ok: true as const, result })),
      ),
      eventBus.get('yield:create-failed').pipe(
        take(1),
        map((failure) => ({ ok: false as const, error: new Error(failure.message) })),
      ),
      timer(30_000).pipe(
        map(() => ({ ok: false as const, error: new Error('Resource creation timed out') })),
      ),
    );

    // Emit the command
    eventBus.get('yield:create').next({
      name: input.name,
      storageUri: input.storageUri,
      contentChecksum: input.contentChecksum,
      byteSize: input.byteSize,
      format: input.format,
      userId,
      language: input.language,
      entityTypes: input.entityTypes,
      creationMethod: input.creationMethod,
      generatedFrom: input.generatedFrom,
      generationPrompt: input.generationPrompt,
      generator: input.generator,
      isDraft: input.isDraft,
    });

    const outcome = await firstValueFrom(result$);
    if (!outcome.ok) {
      throw outcome.error;
    }

    return makeResourceId(outcome.result.resourceId);
  }
}
