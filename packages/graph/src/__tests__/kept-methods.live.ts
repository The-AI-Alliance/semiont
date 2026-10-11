/**
 * The three members no service calls yet, against a real neo4j.
 *
 * `resolveReference`, `findPath` and `getStats` are kept for the Librarian's
 * port (the audit `audit-graph-interface-callers.sh` names them). With no
 * caller, nothing but a test holds them, and a test on the in-memory store
 * holds only that store. So each is asked the same question of both: the
 * in-memory store is the contract's reference, and neo4j answers as it does.
 *
 * `resolveReference` is an update, and is held with the updates
 * (`annotation-update.live.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnnotationId, GraphPath, ResourceId } from '@semiont/core';
import type { GraphDatabase } from '../interface';
import { MemoryGraphDatabase } from '../implementations/memorygraph';
import { AUTHORED, CREATOR, openLiveNeo4j, type LiveNeo4j } from './helpers/live-neo4j';

type Stats = Awaited<ReturnType<GraphDatabase['getStats']>>;

describe('neo4j: the members kept without a caller', () => {
  let live: LiveNeo4j;
  let memory: MemoryGraphDatabase;
  let r1: ResourceId;
  let r2: ResourceId;
  let r3: ResourceId;
  let alone: ResourceId;
  let a12: AnnotationId;
  let a23: AnnotationId;
  let highlight: AnnotationId;
  let place: string;
  let person: string;
  let before: Stats;

  /** The same writes to both stores: r1 → r2 → r3 by links, a highlight on r1, and a resource apart. */
  const write = async (db: GraphDatabase) => {
    await db.createResource(live.descriptor(r1, { entityTypes: [place] }));
    await db.createResource(live.descriptor(r2));
    await db.createResource(live.descriptor(r3, { representations: [{ mediaType: 'text/markdown', checksum: 'sha256:live', rel: 'original' }] }));
    await db.createResource(live.descriptor(alone));
    await db.createAnnotation({
      id: a12,
      motivation: 'linking',
      target: { source: r1, selector: { type: 'TextQuoteSelector', exact: 'to two' } },
      body: [
        { type: 'TextualBody', value: person, purpose: 'tagging' },
        { type: 'SpecificResource', source: r2, purpose: 'linking' },
      ],
      creator: CREATOR,
      created: AUTHORED,
    });
    await db.createAnnotation({
      id: a23,
      motivation: 'linking',
      target: { source: r2 },
      body: [{ type: 'SpecificResource', source: r3, purpose: 'linking' }],
      creator: CREATOR,
      created: AUTHORED,
    });
    await db.createAnnotation({
      id: highlight,
      motivation: 'highlighting',
      target: { source: r1, selector: { type: 'TextQuoteSelector', exact: 'marked' } },
      creator: CREATOR,
      created: AUTHORED,
    });
  };

  const shape = (paths: GraphPath[]) =>
    paths.map((path) => ({
      resources: path.resources.map((resource) => resource['@id']),
      annotations: path.annotations.map((annotation) => annotation.id),
    }));

  beforeAll(async () => {
    live = await openLiveNeo4j('kept');
    memory = new MemoryGraphDatabase();
    await memory.connect();
    r1 = live.resource('r1');
    r2 = live.resource('r2');
    r3 = live.resource('r3');
    alone = live.resource('alone');
    a12 = live.annotation('a12');
    a23 = live.annotation('a23');
    highlight = live.annotation('highlight');
    place = live.tag('Place');
    person = live.tag('Person');

    before = await live.db.getStats();
    await write(live.db);
    await write(memory);
  });

  afterAll(async () => {
    await live.close();
  });

  describe('findPath', () => {
    it('follows links from one resource to another, as the in-memory store does', async () => {
      const expected = shape(await memory.findPath(r1, r3));
      expect(expected).toEqual([{ resources: [r1, r2, r3], annotations: [a12, a23] }]);

      expect(shape(await live.db.findPath(r1, r3))).toEqual(expected);
    });

    it('does not follow a link backwards', async () => {
      expect(shape(await memory.findPath(r3, r1))).toEqual([]);
      expect(shape(await live.db.findPath(r3, r1))).toEqual([]);
    });

    it('finds no path to a resource nothing links to', async () => {
      expect(shape(await memory.findPath(r1, alone))).toEqual([]);
      expect(shape(await live.db.findPath(r1, alone))).toEqual([]);
    });

    it('answers the resource itself when asked for a path to where it starts', async () => {
      const expected = shape(await memory.findPath(r1, r1));
      expect(expected).toEqual([{ resources: [r1], annotations: [] }]);

      expect(shape(await live.db.findPath(r1, r1))).toEqual(expected);
    });

    it('counts resources against its depth: a path of three is not found at a depth of two', async () => {
      expect(shape(await memory.findPath(r1, r3, 2))).toEqual([]);
      expect(shape(await live.db.findPath(r1, r3, 2))).toEqual([]);

      const atThree = shape(await memory.findPath(r1, r3, 3));
      expect(atThree).toHaveLength(1);
      expect(shape(await live.db.findPath(r1, r3, 3))).toEqual(atThree);
    });
  });

  describe('getStats', () => {
    it('counts what these writes added, as the in-memory store counts them', async () => {
      const expected = await memory.getStats();
      expect(expected).toMatchObject({
        resourceCount: 4,
        annotationCount: 3,
        highlightCount: 1,
        referenceCount: 2,
        entityReferenceCount: 1,
      });

      // The database may hold other rows, so neo4j's answer is what it gained.
      const after = await live.db.getStats();
      const gained = (key: 'resourceCount' | 'annotationCount' | 'highlightCount' | 'referenceCount' | 'entityReferenceCount') =>
        after[key] - before[key];
      expect({
        resourceCount: gained('resourceCount'),
        annotationCount: gained('annotationCount'),
        highlightCount: gained('highlightCount'),
        referenceCount: gained('referenceCount'),
        entityReferenceCount: gained('entityReferenceCount'),
      }).toEqual({
        resourceCount: expected.resourceCount,
        annotationCount: expected.annotationCount,
        highlightCount: expected.highlightCount,
        referenceCount: expected.referenceCount,
        entityReferenceCount: expected.entityReferenceCount,
      });

      expect(after.entityTypes[place]).toBe(expected.entityTypes[place]);
      expect((after.contentTypes['text/markdown'] ?? 0) - (before.contentTypes['text/markdown'] ?? 0)).toBe(
        expected.contentTypes['text/markdown'],
      );
      expect((after.contentTypes['text/plain'] ?? 0) - (before.contentTypes['text/plain'] ?? 0)).toBe(
        expected.contentTypes['text/plain'],
      );
    });

    it('does not count a resource the graph has only been told of by a link', async () => {
      const unseen = live.resource('unseen');
      const settled = await live.db.getStats();

      await live.db.updateAnnotation(highlight, {
        body: [{ type: 'SpecificResource', source: unseen, purpose: 'linking' }],
      });

      const withStub = await live.db.getStats();
      expect(withStub.resourceCount).toBe(settled.resourceCount);
      expect(Object.keys(withStub.contentTypes)).not.toContain('null');
    });
  });
});
