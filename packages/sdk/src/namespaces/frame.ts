/**
 * FrameNamespace — the eighth flow's surface.
 *
 * Frame operates on the KB's **schema layer** — the conceptual vocabulary
 * the other seven flows are expressed in. Where yield/mark/match/bind/
 * gather/browse/beckon act on content (resources, annotations, references,
 * attention), Frame acts on what *kinds* of things exist: entity types,
 * eventually tag schemas, relation/predicate types, ontology imports.
 *
 * The MVP owns a single primitive — entity-type vocabulary writes on the
 * `frame:add-entity-type` channel. See `docs/protocol/flows/FRAME.md`
 * for the per-flow contract.
 *
 * Live reads of the entity-type vocabulary stay on Browse
 * (`browse.entityTypes()` is a `CacheObservable<string[]>`). Frame owns
 * writes; Browse owns reads. The asymmetry is intentional — re-implementing
 * Browse's cache primitives on Frame for a single read would duplicate
 * machinery without benefit.
 */

import type { ITransport, TagSchema } from '@semiont/core';
import { busRequest } from '@semiont/core';
import type { FrameNamespace as IFrameNamespace } from './types';

export class FrameNamespace implements IFrameNamespace {
  constructor(private readonly transport: ITransport) {}

  // Writes are confirmed: each awaits the backend's correlation-keyed
  // `*-add-ok`/`*-add-failed` reply (bridged) via busRequest and REJECTS on
  // failure — a remote add-failure is surfaced to the caller, never silently
  // dropped (.plans/bugs/BRIDGE-GAPS.md).
  async addEntityType(type: string): Promise<void> {
    await busRequest<void>(
      this.transport,
      'frame:add-entity-type',
      { tag: type },
      'frame:entity-type-add-ok',
      'frame:entity-type-add-failed',
    );
  }

  async addEntityTypes(types: string[]): Promise<void> {
    for (const tag of types) {
      await busRequest<void>(
        this.transport,
        'frame:add-entity-type',
        { tag },
        'frame:entity-type-add-ok',
        'frame:entity-type-add-failed',
      );
    }
  }

  async addTagSchema(schema: TagSchema): Promise<void> {
    await busRequest<void>(
      this.transport,
      'frame:add-tag-schema',
      { schema },
      'frame:tag-schema-add-ok',
      'frame:tag-schema-add-failed',
    );
  }
}
