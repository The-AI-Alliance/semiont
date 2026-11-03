/**
 * Where a Smelter keeps its knowledge base's index (SMELTER.md § The index):
 * in collections of that knowledge base's own, named from its DID as
 * protocol/specs/src/vectors/payload-cases.json states. Another knowledge
 * base's collections on the same Qdrant are none of its: its start neither
 * reads them nor purges them, making its own index anew leaves them as they
 * are, and what it writes lands in its own. With it, that the suite names a
 * knowledge base's collections as the table's `collectionsNamed` cases state.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kbDid } from '@semiont/core';
import { describe, expect, inject, it } from 'vitest';
import { SPEC_SOURCE } from '../harness/paths';
import { collectionNames, collectionsAt, vectorIndex, type Collection, type Point } from '../harness/qdrant';
import { kbIdentity } from '../harness/spec';
import { eachSmelter } from '../harness/smelter-world';

/** What of the payload table these cases read: its stored points, and the names it gives knowledge bases' collections. */
interface Stated {
  cases: Array<{
    why: string;
    resourceStored?: { chunks: Array<{ embedding: number[] }>; points: Array<{ qdrantId: string; payload: Record<string, unknown> }> };
    annotationStored?: { embedding: number[]; point: { qdrantId: string; payload: Record<string, unknown> } };
    declineStored?: { point: { qdrantId: string; payload: Record<string, unknown> } };
    collectionsNamed?: { kb: string; names: Record<string, string> };
  }>;
}

const table = JSON.parse(readFileSync(join(SPEC_SOURCE, 'vectors/payload-cases.json'), 'utf8')) as Stated;

/** Each knowledge base the table names the collections of, with their names. */
const NAMED = table.cases.flatMap((one) => (one.collectionsNamed === undefined ? [] : [{ why: one.why, ...one.collectionsNamed }]));

describe("a knowledge base's collections, as the suite names them", () => {
  it.each(NAMED)('$why', ({ kb, names }) => {
    expect(collectionNames(kb)).toEqual(names);
  });
});

/** The collections of a knowledge base's index, by their words. */
const COLLECTIONS: readonly Collection[] = ['resources', 'annotations', 'declined'];

/** Another knowledge base than the one the suite's Smelter serves. */
const OTHER_KB = kbIdentity('plain scalars, and a version, which names nothing').did;

/** The first case of a part of the table: a case fails here where the table has none. */
function first<T>(found: T | undefined, what: string): T {
  if (found === undefined) throw new Error(`protocol/specs/src/vectors/payload-cases.json states no ${what}`);
  return found;
}

const stored = first(table.cases.find((one) => one.resourceStored)?.resourceStored, 'resource stored');
const annotated = first(table.cases.find((one) => one.annotationStored)?.annotationStored, 'annotation stored');
const declined = first(table.cases.find((one) => one.declineStored)?.declineStored, 'decline stored');

/**
 * What the other knowledge base's index holds: the points the table states of
 * a resource, an annotation and a decline, each with its vector. None of their
 * resources is of the record the Smelter reads, so a Smelter that read these
 * collections as its own would purge every one of them.
 */
const PLANTED: Readonly<Record<Collection, Point[]>> = {
  resources: stored.points.map((point, at) => ({ id: point.qdrantId, payload: point.payload, vector: first(stored.chunks[at], 'chunk').embedding })),
  annotations: [{ id: annotated.point.qdrantId, payload: annotated.point.payload, vector: annotated.embedding }],
  // A point of the declined has the vector that says nothing.
  declined: [{ id: declined.point.qdrantId, payload: declined.point.payload, vector: [0] }],
};

eachSmelter('a Smelter beside another knowledge base on its Qdrant', (world) => {
  it("neither reads nor purges nor writes the other knowledge base's collections, and fills its own", async () => {
    const text = 'This text is of the knowledge base the Smelter serves, and of no other.';
    const id = await world().created(text, 'text/plain', { name: 'Its own' });
    expect(await world().settled(id)).toMatchObject({ outcome: 'indexed' });

    const { host } = inject('vectorDatabase');
    const other = vectorIndex(host, OTHER_KB);
    await world().stop();
    await world().clearIndex();
    // The other knowledge base's index, made as a store makes one: as wide as the table's vectors, which are not the Smelter's model's.
    await other.make('resources', 3);
    await other.make('annotations', 3);
    await other.make('declined', 1);
    for (const collection of COLLECTIONS) await other.put(collection, PLANTED[collection]);
    const before = await Promise.all(COLLECTIONS.map((collection) => other.points(collection, true)));
    await world().start();

    // Its start found its own index gone, made it anew, and filled it from the record: its one resource, and nothing purged.
    const { reconcile } = await world().smelter.health();
    expect(reconcile.phase).toBe('done');
    expect(reconcile.summary).toMatchObject({ resourcesEmbedded: 1, resourceVectorsDeleted: 0, annotationVectorsDeleted: 0 });
    expect(await world().index.pointsOf('resources', id)).not.toEqual([]);
    for (const collection of COLLECTIONS) {
      for (const point of PLANTED[collection]) expect(await world().index.pointsOf(collection, String(point.payload['resourceId']))).toEqual([]);
    }

    // The other's points are as they were put, and none of the Smelter's is among them.
    expect(await Promise.all(COLLECTIONS.map((collection) => other.points(collection, true)))).toEqual(before);
    expect(await other.pointsOf('resources', id)).toEqual([]);
    const own = Object.values(collectionNames(kbDid(world().kb.world.served.domain)));
    const others = Object.values(collectionNames(OTHER_KB));
    expect((await collectionsAt(host)).sort()).toEqual([...own, ...others].sort());
  });
});
