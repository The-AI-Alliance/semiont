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
import type { FrameNamespace as IFrameNamespace } from './types';

export class FrameNamespace implements IFrameNamespace {
  constructor(private readonly transport: ITransport) {}

  async addEntityType(type: string): Promise<void> {
    await this.transport.emit('frame:add-entity-type', { tag: type });
  }

  async addEntityTypes(types: string[]): Promise<void> {
    for (const tag of types) {
      await this.transport.emit('frame:add-entity-type', { tag });
    }
  }

  async addTagSchema(schema: TagSchema): Promise<void> {
    await this.transport.emit('frame:add-tag-schema', { schema });
  }
}
