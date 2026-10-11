/**
 * What a point of the vector index is, held to
 * specs/src/vectors/payload-cases.json: the table every implementation of the
 * stores runs, so that a point one of them writes is a point another reads.
 *
 * The two stores are run as far as each can be watched. The Qdrant store has
 * no Qdrant under it here: its client is faked, records what it is sent and
 * answers what a test hands it, so the store is held to the ids, vectors and
 * payloads it sends and to what it reads of a payload it is answered. The
 * in-memory store shows no payload and can be handed none, so it is held to
 * what it answers after a write: the stamp, the result of a search, an
 * annotation's id. The table's `$comment` says which of its statements are
 * the Qdrant store's alone.
 *
 * The fake follows qdrant-query-api.test.ts: `qdrant.ts` imports the client
 * inside `connect()`, which is after the class below exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { annotationId, resourceId } from '@semiont/core';
import type { VectorSearchResult } from '../store/interface';
import { MemoryVectorStore } from '../store/memory';

type Payload = Record<string, unknown>;

interface Chunk {
  index: number;
  text: string;
  embedding: number[];
}

interface Result {
  score: number;
  resourceId: string;
  annotationId?: string;
  text: string;
  entityTypes?: string[];
  machineRead?: boolean;
}

interface Stamp {
  contentChecksum?: string;
  entityTypes: string[];
  machineRead?: boolean;
}

interface Point {
  qdrantId: string;
  payload: Payload;
  result: Result;
}

interface Collection {
  name: string;
  distance: string;
  indexes: Record<string, string>;
}

interface Case {
  why: string;
  resourceStored?: {
    resourceId: string;
    chunks: Chunk[];
    contentChecksum: string;
    entityTypes: string[];
    machineRead?: boolean;
    points: Point[];
    stamp: Stamp;
  };
  annotationStored?: {
    annotationId: string;
    resourceId: string;
    motivation: string;
    entityTypes: string[];
    text: string;
    embedding: number[];
    machineRead?: boolean;
    point: Point;
  };
  stampRead?: { payload: Payload; stamp?: Stamp };
  resultRead?: { collection: 'resources' | 'annotations'; payload: Payload; score: number; result: Result };
}

const table: { collections: { resources: Collection; annotations: Collection }; cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/vectors/payload-cases.json', import.meta.url), 'utf8'),
);

const PARTS = ['resourceStored', 'annotationStored', 'stampRead', 'resultRead'] as const;
type Part = (typeof PARTS)[number];

/** Every member a part may state. A member that is none of these is one this runner would not read. */
const MEMBERS: Record<Part, readonly string[]> = {
  resourceStored: ['resourceId', 'chunks', 'contentChecksum', 'entityTypes', 'machineRead', 'points', 'stamp'],
  annotationStored: ['annotationId', 'resourceId', 'motivation', 'entityTypes', 'text', 'embedding', 'machineRead', 'point'],
  stampRead: ['payload', 'stamp'],
  resultRead: ['collection', 'payload', 'score', 'result'],
};
const CHUNK_MEMBERS = ['index', 'text', 'embedding'];
const POINT_MEMBERS = ['qdrantId', 'payload', 'result'];

const unread = (value: object, known: readonly string[]): string[] =>
  Object.keys(value).filter((member) => !known.includes(member));

const part = <K extends Part>(key: K) =>
  table.cases.flatMap((c) => (c[key] ? [{ why: c.why, given: c[key] as NonNullable<Case[K]> }] : []));

/** How closely a score is compared: the table states one to six decimal places. */
const SCORE_TOLERANCE = 0.000001;

/** A result without its `id`, which is each store's own key, and without its score, which is compared apart. */
const stated = (result: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(result).filter(([member]) => member !== 'id' && member !== 'score'));

function expectResults(answered: VectorSearchResult[], expected: Result[]): void {
  expect(answered.map(stated)).toEqual(expected.map(stated));
  answered.forEach((result, at) => {
    expect(Math.abs(result.score - expected[at].score), `the score of result ${at}`).toBeLessThanOrEqual(SCORE_TOLERANCE);
  });
}

/** How wide the faked embedding model's vectors are: what a collection made here must be as wide as. */
const WIDTH = 3;

interface Written {
  collection: string;
  points: unknown[];
}

/** Whether the faked Qdrant has its collections already; what it was asked to make and to write; what it answers a read. */
let collectionsExist = true;
let collectionsMade: Record<string, unknown> = {};
let indexesMade: Record<string, Record<string, unknown>> = {};
let written: Written[] = [];
let scrolled: Payload[] = [];
let queried: Array<{ id: string; score: number; payload: Payload }> = [];

/** A client shaped like 1.19.0, with the methods the writes and reads here call. */
class FakeQdrantClient {
  async getCollection() {
    if (!collectionsExist) throw new Error('no such collection');
    return {};
  }

  async createCollection(name: string, body: { vectors: unknown }) {
    collectionsMade[name] = body.vectors;
    return true;
  }

  async createPayloadIndex(collection: string, body: { field_name: string; field_schema: unknown }) {
    indexesMade[collection] = { ...indexesMade[collection], [body.field_name]: body.field_schema };
    return {};
  }

  async delete() {
    return {};
  }

  async upsert(collection: string, body: { points: unknown[] }) {
    written.push({ collection, points: body.points });
    return {};
  }

  async scroll() {
    return { points: scrolled.map((payload, at) => ({ id: `scrolled-${at}`, payload })), next_page_offset: null };
  }

  async query() {
    return { points: queried };
  }
}

vi.mock('@qdrant/js-client-rest', () => ({ QdrantClient: FakeQdrantClient }));

import { QdrantVectorStore } from '../store/qdrant';

async function connected(): Promise<QdrantVectorStore> {
  const store = new QdrantVectorStore({ host: 'localhost', port: 6333, dimensions: async () => WIDTH });
  await store.connect();
  return store;
}

describe('what a point of the vector index is (specs/src/vectors/payload-cases.json)', () => {
  it('has a case of each of its four parts, each case of one part, and no member this runner would not read', () => {
    for (const key of PARTS) expect(part(key).length, key).toBeGreaterThan(0);
    for (const c of table.cases) {
      const parts = PARTS.filter((key) => c[key]);
      expect(parts, c.why).toHaveLength(1);
      expect(unread(c, ['why', ...parts]), c.why).toEqual([]);
      for (const key of parts) expect(unread(c[key] ?? {}, MEMBERS[key]), c.why).toEqual([]);
      for (const chunk of c.resourceStored?.chunks ?? []) expect(unread(chunk, CHUNK_MEMBERS), c.why).toEqual([]);
      for (const point of [...(c.resourceStored?.points ?? []), ...(c.annotationStored ? [c.annotationStored.point] : [])]) {
        expect(unread(point, POINT_MEMBERS), c.why).toEqual([]);
      }
    }
  });

  describe('the Qdrant store, on a client that records what it is sent', () => {
    beforeEach(() => {
      collectionsExist = true;
      collectionsMade = {};
      indexesMade = {};
      written = [];
      scrolled = [];
      queried = [];
    });

    it('makes the collections the table states, each as wide as the embedding model and compared and indexed as stated', async () => {
      collectionsExist = false;
      await connected();

      const collections = Object.values(table.collections);
      expect(collectionsMade).toStrictEqual(
        Object.fromEntries(collections.map(({ name, distance }) => [name, { size: WIDTH, distance }])),
      );
      expect(indexesMade).toStrictEqual(Object.fromEntries(collections.map(({ name, indexes }) => [name, indexes])));
    });

    describe("a resource's chunks, stored", () => {
      for (const { why, given } of part('resourceStored')) {
        it(why, async () => {
          const store = await connected();
          const id = resourceId(given.resourceId);

          await store.upsertResourceVectors(
            id,
            given.chunks.map(({ index, text, embedding }) => ({ chunkIndex: index, text, embedding })),
            given.contentChecksum,
            given.entityTypes,
            given.machineRead,
          );

          expect(given.points).toHaveLength(given.chunks.length);
          expect(written).toStrictEqual([
            {
              collection: table.collections.resources.name,
              points: given.points.map((point, at) => ({
                id: point.qdrantId,
                vector: given.chunks[at].embedding,
                payload: point.payload,
              })),
            },
          ]);

          scrolled = given.points.map((point) => point.payload);
          expect(await store.getResourceStamp(id)).toEqual(given.stamp);
          expect(Object.fromEntries(await store.listResourceStamps())).toEqual({ [given.resourceId]: given.stamp });

          for (const [at, point] of given.points.entries()) {
            queried = [{ id: point.qdrantId, score: point.result.score, payload: point.payload }];
            const found = await store.searchResources(given.chunks[at].embedding, { limit: 1 });
            expectResults(found, [point.result]);
            expect(found.map((result) => result.id)).toEqual([point.qdrantId]);
          }
        });
      }
    });

    describe('an annotation, stored', () => {
      for (const { why, given } of part('annotationStored')) {
        it(why, async () => {
          const store = await connected();
          const id = annotationId(given.annotationId);

          await store.upsertAnnotationVector(id, given.embedding, {
            annotationId: id,
            resourceId: resourceId(given.resourceId),
            motivation: given.motivation,
            entityTypes: given.entityTypes,
            exactText: given.text,
            machineRead: given.machineRead,
          });

          expect(written).toStrictEqual([
            {
              collection: table.collections.annotations.name,
              points: [{ id: given.point.qdrantId, vector: given.embedding, payload: given.point.payload }],
            },
          ]);

          scrolled = [given.point.payload];
          expect([...(await store.listAnnotationIds())]).toEqual([given.annotationId]);

          queried = [{ id: given.point.qdrantId, score: given.point.result.score, payload: given.point.payload }];
          const found = await store.searchAnnotations(given.embedding, { limit: 1 });
          expectResults(found, [given.point.result]);
          expect(found.map((result) => result.id)).toEqual([given.point.qdrantId]);
        });
      }
    });

    describe('a stamp, read', () => {
      for (const { why, given } of part('stampRead')) {
        it(why, async () => {
          const store = await connected();
          scrolled = [given.payload];
          const listed = Object.fromEntries(await store.listResourceStamps());
          const named = given.payload.resourceId;

          if (given.stamp === undefined) {
            expect(named).toBeUndefined();
            expect(listed).toEqual({});
          } else {
            if (typeof named !== 'string') throw new Error('a payload a stamp is read from names its resource');
            expect(listed).toEqual({ [named]: given.stamp });
            expect(await store.getResourceStamp(resourceId(named))).toEqual(given.stamp);
          }
        });
      }
    });

    describe('a result, read', () => {
      for (const { why, given } of part('resultRead')) {
        it(why, async () => {
          const store = await connected();
          queried = [{ id: 'a-point', score: given.score, payload: given.payload }];

          const searches = {
            resources: () => store.searchResources([1, 0, 0], { limit: 1 }),
            annotations: () => store.searchAnnotations([1, 0, 0], { limit: 1 }),
          };
          expect(Object.keys(searches)).toContain(given.collection);

          expectResults(await searches[given.collection](), [given.result]);
        });
      }
    });
  });

  describe('the in-memory store, by what it answers after the write', () => {
    describe("a resource's chunks, stored", () => {
      for (const { why, given } of part('resourceStored')) {
        it(why, async () => {
          const store = new MemoryVectorStore();
          const id = resourceId(given.resourceId);

          await store.upsertResourceVectors(
            id,
            given.chunks.map(({ index, text, embedding }) => ({ chunkIndex: index, text, embedding })),
            given.contentChecksum,
            given.entityTypes,
            given.machineRead,
          );

          expect(await store.count()).toBe(given.points.length);
          expect(await store.getResourceStamp(id)).toEqual(given.stamp);
          expect(Object.fromEntries(await store.listResourceStamps())).toEqual({ [given.resourceId]: given.stamp });
          for (const [at, point] of given.points.entries()) {
            expectResults(await store.searchResources(given.chunks[at].embedding, { limit: 1 }), [point.result]);
          }
        });
      }
    });

    describe('an annotation, stored', () => {
      for (const { why, given } of part('annotationStored')) {
        it(why, async () => {
          const store = new MemoryVectorStore();
          const id = annotationId(given.annotationId);

          await store.upsertAnnotationVector(id, given.embedding, {
            annotationId: id,
            resourceId: resourceId(given.resourceId),
            motivation: given.motivation,
            entityTypes: given.entityTypes,
            exactText: given.text,
            machineRead: given.machineRead,
          });

          expect([...(await store.listAnnotationIds())]).toEqual([given.annotationId]);
          expectResults(
            await store.searchAnnotations(given.embedding, { limit: 1, filter: { motivation: given.motivation } }),
            [given.point.result],
          );
        });
      }
    });
  });
});
