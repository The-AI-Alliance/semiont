/**
 * Resource Operations
 *
 * Business logic for resource operations. All writes ride a
 * `BusRequestPrimitive` the CALLER supplies — the operation names channels,
 * the caller names the fabric. The Stower actor handles persistence wherever
 * it lives: beside an in-process bus (`asBusRequestPrimitive`), or across
 * the signal plane (the gateway's `requestPrimitiveFor` — a raw-bus emit
 * from the gateway starves under a remote plane, the `yield:create` bug of
 * 2026-09-15).
 *
 * For create: emits yield:create, awaits yield:create-ok / yield:create-failed.
 */

import type { UserId, ResourceId } from './identifiers';
import { resourceId as makeResourceId } from './identifiers';
import type { components } from './types';
import { busRequest, type BusRequestPrimitive } from './bus-request';

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
  /** The job this resource fulfils, when a worker is creating it. Forwarded onto yield:create. */
  jobId?: string;
  isDraft?: boolean;
}

export class ResourceOperations {
  /**
   * Create a new resource via EventBus → Stower
   */
  static async createResource(
    input: CreateResourceInput,
    userId: UserId,
    bus: BusRequestPrimitive,
  ): Promise<ResourceId> {
    // Confirmed in-process write over busRequest: the reply is matched by
    // correlationId, so concurrent creates can't cross-resolve (the old race()
    // took the first yield:create-ok on the channel regardless of which create
    // it answered). In-process callers stamp `_userId` directly, mirroring what
    // the gateway does for wire callers.
    const { resourceId: rId } = await busRequest(
      bus,
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
        jobId: input.jobId,
        isDraft: input.isDraft,
      },
    );

    return makeResourceId(rId);
  }

  /**
   * Persist a CLONE via EventBus → Stower.
   *
   * Separate from `createResource` because a clone is a separate fact: it
   * names its parent, and `yield:cloned` requires that name. Callers reach
   * this only after the CloneTokenManager has validated the token — it is the
   * inner half of the flow, not a public entry point.
   */
  static async persistClone(
    input: {
      name: string;
      storageUri: string;
      contentChecksum: string;
      byteSize: number;
      format: ContentFormat;
      parentResourceId: string;
      entityTypes?: string[];
      language?: string;
    },
    userId: UserId,
    bus: BusRequestPrimitive,
  ): Promise<ResourceId> {
    const { resourceId: rId } = await busRequest(
      bus,
      'yield:clone-persist',
      {
        name: input.name,
        storageUri: input.storageUri,
        contentChecksum: input.contentChecksum,
        byteSize: input.byteSize,
        format: input.format,
        parentResourceId: input.parentResourceId,
        entityTypes: input.entityTypes,
        language: input.language,
        _userId: userId,
      },
    );

    return makeResourceId(rId);
  }

  /**
   * Create a resource from a clone token via EventBus → CloneTokenManager.
   * The bytes are already stored (the gateway's upload path, `noGit` — the
   * Archivist's register does the one `git add`, D4b); the command carries
   * storage coordinates only (EXTRACT-ARCHIVIST P3, D4a).
   */
  static async createFromCloneToken(
    input: {
      token: string;
      name: string;
      storageUri: string;
      contentChecksum: string;
      byteSize: number;
      format: ContentFormat;
      archiveOriginal?: boolean;
    },
    userId: UserId,
    bus: BusRequestPrimitive,
  ): Promise<ResourceId> {
    const { resourceId: rId } = await busRequest(
      bus,
      'yield:clone-create',
      {
        token: input.token,
        name: input.name,
        storageUri: input.storageUri,
        contentChecksum: input.contentChecksum,
        byteSize: input.byteSize,
        format: input.format,
        archiveOriginal: input.archiveOriginal,
        _userId: userId,
      },
    );

    return makeResourceId(rId);
  }
}
