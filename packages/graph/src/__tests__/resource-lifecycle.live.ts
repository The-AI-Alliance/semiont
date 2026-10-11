/**
 * A resource's node through its life, against a real neo4j: a stub that a
 * link made before the resource arrived, the resource itself, and what a
 * delete leaves. The Weaver rebuilds one resource by deleting it and applying
 * its events again, so what a delete removes is what a rebuild costs every
 * other resource.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnnotationId, ResourceId } from '@semiont/core';
import { AUTHORED, CREATOR, openLiveNeo4j, type LiveNeo4j } from './helpers/live-neo4j';

describe('neo4j: a resource through its life', () => {
  let live: LiveNeo4j;

  beforeAll(async () => {
    live = await openLiveNeo4j('lifecycle');
  });

  afterAll(async () => {
    await live.close();
  });

  describe('a resource, written and read', () => {
    it('reads back as it was written: its date, both parties it is by, where it is stored', async () => {
      const id = live.resource('written');
      const written = live.descriptor(id, {
        name: 'Cedar County, Iowa',
        entityTypes: ['Place', 'County'],
        representations: [
          { mediaType: 'text/markdown', checksum: 'sha256:abc', rel: 'original', storageUri: 'file:///kb/cedar.md' },
        ],
        wasAttributedTo: [
          CREATOR,
          { '@type': 'Software', '@id': 'did:web:example.org:agents:anthropic:model', name: 'model' },
        ],
      });

      expect(await live.db.createResource(written)).toEqual(written);
      expect(await live.db.getResource(id)).toEqual(written);

      const [row] = await live.rows('MATCH (d:Resource {id: $id}) RETURN keys(d) AS keys, d.created AS created', { id });
      expect([...(row!.keys as string[])].sort()).toEqual(
        ['archived', 'contentChecksum', 'created', 'creator', 'entityTypes', 'format', 'id', 'name', 'storageUri'],
      );
      expect(row!.created).toBe(AUTHORED);
    });

    it('written in a batch, reads back the same', async () => {
      const first = live.descriptor(live.resource('batch-1'));
      const second = live.descriptor(live.resource('batch-2'), { archived: true });

      expect(await live.db.batchCreateResources([first, second])).toEqual([first, second]);
      expect(await live.db.getResource(second['@id'])).toEqual(second);
    });

    it('written again, is the same one resource', async () => {
      const id = live.resource('again');
      await live.db.createResource(live.descriptor(id));
      await live.db.createResource(live.descriptor(id, { name: 'Renamed' }));

      expect(await live.rows('MATCH (d:Resource {id: $id}) RETURN d.name AS name', { id })).toEqual([{ name: 'Renamed' }]);
    });
  });

  describe('a stub: a link\'s target the graph has not been given yet', () => {
    let from: ResourceId;
    let unseen: ResourceId;
    let link: AnnotationId;

    beforeAll(async () => {
      from = live.resource('stub-from');
      unseen = live.resource('stub-unseen');
      link = live.annotation('stub-link');
      await live.db.createResource(live.descriptor(from));
      await live.db.createAnnotation({
        id: link,
        motivation: 'linking',
        target: { source: from },
        creator: CREATOR,
        created: AUTHORED,
      });
      await live.db.updateAnnotation(link, {
        body: [{ type: 'SpecificResource', source: unseen, purpose: 'linking' }],
      });
    });

    it('is not a resource the graph has: asking for it answers none', async () => {
      expect(await live.db.getResource(unseen)).toBeNull();
    });

    it('is not a connection of the resource that links to it', async () => {
      expect(await live.db.getResourceConnections(from)).toEqual([]);
    });

    it('becomes a connection once the resource arrives, with no mark left that it was a stub', async () => {
      await live.db.createResource(live.descriptor(unseen));
      expect(await live.rows('MATCH (d:Resource {id: $id}) RETURN d.stub AS stub', { id: unseen })).toEqual([{ stub: null }]);

      const connections = await live.db.getResourceConnections(from);
      expect(connections.map((c) => c.targetResource['@id'])).toEqual([unseen]);
      expect(connections[0]!.annotations.map((a) => a.id)).toEqual([link]);
    });
  });

  describe('deleting a resource', () => {
    let gone: ResourceId;
    let other: ResourceId;
    let own: AnnotationId;
    let linkToGone: AnnotationId;

    beforeAll(async () => {
      gone = live.resource('delete-gone');
      other = live.resource('delete-other');
      own = live.annotation('delete-own');
      linkToGone = live.annotation('delete-link');
      await live.db.createResource(live.descriptor(gone));
      await live.db.createResource(live.descriptor(other));
      await live.db.createAnnotation({
        id: own,
        motivation: 'highlighting',
        target: { source: gone, selector: { type: 'TextQuoteSelector', exact: 'mine' } },
        creator: CREATOR,
        created: AUTHORED,
      });
      await live.db.createAnnotation({
        id: linkToGone,
        motivation: 'linking',
        target: { source: other },
        body: [{ type: 'SpecificResource', source: gone, purpose: 'linking' }],
        creator: CREATOR,
        created: AUTHORED,
      });

      await live.db.deleteResource(gone);
    });

    it('removes the resource and the annotations on it', async () => {
      expect(await live.db.getResource(gone)).toBeNull();
      expect(await live.db.getAnnotation(own)).toBeNull();
      expect(await live.db.getResourceAnnotations(gone)).toEqual([]);
    });

    it('leaves another resource\'s annotation that links to it, link and all', async () => {
      const kept = await live.db.getAnnotation(linkToGone);
      expect(kept?.body).toEqual([{ type: 'SpecificResource', source: gone, purpose: 'linking' }]);
      expect((await live.db.getResourceAnnotations(other)).map((a) => a.id)).toEqual([linkToGone]);
    });

    it('is followed by that link again when the resource is created again', async () => {
      await live.db.createResource(live.descriptor(gone));

      expect((await live.db.getResourceReferencedBy(gone)).map((a) => a.id)).toEqual([linkToGone]);
      expect((await live.db.getResourceConnections(other)).map((c) => c.targetResource['@id'])).toEqual([gone]);
    });

    it('leaves nothing at all of a resource nothing links to', async () => {
      const unlinked = live.resource('delete-unlinked');
      await live.db.createResource(live.descriptor(unlinked));

      await live.db.deleteResource(unlinked);

      expect(await live.rows('MATCH (d:Resource {id: $id}) RETURN d', { id: unlinked })).toEqual([]);
    });
  });
});
