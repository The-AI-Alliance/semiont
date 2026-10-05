/**
 * FrameNamespace — the eighth flow's surface.
 *
 * Frame operates on the KB's **schema layer** — the conceptual vocabulary
 * the other seven flows are expressed in. Where yield/mark/match/bind/
 * gather/browse/beckon act on content (resources, annotations, references,
 * attention), Frame acts on what *kinds* of things exist: entity types and
 * tag schemas. Relation/predicate types and ontology imports are not part
 * of it.
 *
 * It owns the vocabulary writes, on the `frame:add-entity-type` and
 * `frame:add-tag-schema` channels. See `docs/protocol/flows/FRAME.md`
 * for the per-flow contract.
 *
 * Live reads of the vocabulary stay on Browse (`browse.entityTypes()`,
 * `browse.tagSchemas()`). Frame owns writes; Browse owns reads. The
 * asymmetry is intentional — re-implementing Browse's cache primitives on
 * Frame for its reads would duplicate machinery without benefit.
 */

import type { ITransport, TagSchema } from '@semiont/core';
import { busRequest } from '@semiont/core';
import type { FrameNamespace as IFrameNamespace } from './types';

export class FrameNamespace implements IFrameNamespace {
  constructor(private readonly transport: ITransport) {}

  // Writes are confirmed: each awaits the gateway's correlation-keyed
  // `*-add-ok`/`*-add-failed` reply (bridged) via busRequest and REJECTS on
  // failure — a remote add-failure is surfaced to the caller, never silently
  // dropped.
  async addEntityType(type: string): Promise<void> {
    await busRequest(
      this.transport,
      'frame:add-entity-type',
      { tag: type },
    );
  }

  async addEntityTypes(types: string[]): Promise<void> {
    for (const tag of types) {
      await busRequest(
        this.transport,
        'frame:add-entity-type',
        { tag },
      );
    }
  }

  async addTagSchema(schema: TagSchema): Promise<void> {
    await busRequest(
      this.transport,
      'frame:add-tag-schema',
      { schema },
    );
  }
}
