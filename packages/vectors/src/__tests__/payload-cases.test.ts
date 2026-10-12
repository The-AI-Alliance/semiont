/**
 * What a point of the vector index is, held to
 * specs/src/vectors/payload-cases.json: the table every implementation of the
 * stores runs, so that a point one of them writes is a point another reads.
 *
 * This package searches the index and writes no point, so it runs the parts a
 * reader has: the collections a store makes where a Qdrant has none, and the
 * result a search reads from a point's payload, of each stored point and of
 * each `resultRead`. The parts that are the writer's alone (the id, the
 * vector and the payload a chunk and an annotation are stored as, and a stamp
 * read) are run by the writer's stores, in packages/vectors-python.
 *
 * The Qdrant store has no Qdrant under it here: its client is faked, and
 * answers a search with the points a test hands it. The in-memory store is
 * made holding the stored points, each with the payload the table states.
 *
 * The fake follows qdrant-query-api.test.ts: `qdrant.ts` imports the client
 * inside `connect()`, which is after the class below exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VectorSearchResult } from '../store/interface';
import { MemoryVectorStore, type MemoryPoint } from '../store/memory';

interface Chunk {
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

interface Point {
  qdrantId: string;
  payload: MemoryPoint['payload'];
  result: Result;
}

interface Collection {
  name: string;
  distance: string;
  indexes: Record<string, string>;
}

interface Case {
  why: string;
  resourceStored?: { chunks: Chunk[]; points: Point[] };
  annotationStored?: { motivation: string; embedding: number[]; point: Point };
  stampRead?: object;
  resultRead?: { collection: 'resources' | 'annotations'; payload: object; score: number; result: Result };
}

const table: { collections: { resources: Collection; annotations: Collection }; cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/vectors/payload-cases.json', import.meta.url), 'utf8'),
);

/** The parts a case may be of. This runner runs every one but `stampRead`. */
const PARTS = ['resourceStored', 'annotationStored', 'stampRead', 'resultRead'] as const;
type Part = (typeof PARTS)[number];

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

/** Whether the faked Qdrant has its collections already; what it was asked to make; what it answers a search. */
let collectionsExist = true;
let collectionsMade: Record<string, unknown> = {};
let indexesMade: Record<string, Record<string, unknown>> = {};
let queried: Array<{ id: string; score: number; payload: object }> = [];

/** A client shaped like 1.19.0, with the methods a connect and a search call. */
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
  it('has a case of each part this runner runs, and each case is of one part', () => {
    for (const key of ['resourceStored', 'annotationStored', 'resultRead'] as const) {
      expect(part(key).length, key).toBeGreaterThan(0);
    }
    for (const c of table.cases) {
      expect(PARTS.filter((key) => c[key]), c.why).toHaveLength(1);
    }
    for (const { why, given } of part('resourceStored')) {
      expect(given.points, why).toHaveLength(given.chunks.length);
    }
  });

  describe('the Qdrant store, on a client that answers what it is handed', () => {
    beforeEach(() => {
      collectionsExist = true;
      collectionsMade = {};
      indexesMade = {};
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

    describe("a resource's chunks, stored, and each point's result read", () => {
      for (const { why, given } of part('resourceStored')) {
        it(why, async () => {
          const store = await connected();

          for (const [at, point] of given.points.entries()) {
            queried = [{ id: point.qdrantId, score: point.result.score, payload: point.payload }];
            const found = await store.searchResources(given.chunks[at].embedding, { limit: 1 });
            expectResults(found, [point.result]);
            expect(found.map((result) => result.id)).toEqual([point.qdrantId]);
          }
        });
      }
    });

    describe("an annotation, stored, and its point's result read", () => {
      for (const { why, given } of part('annotationStored')) {
        it(why, async () => {
          const store = await connected();

          queried = [{ id: given.point.qdrantId, score: given.point.result.score, payload: given.point.payload }];
          const found = await store.searchAnnotations(given.embedding, { limit: 1 });
          expectResults(found, [given.point.result]);
          expect(found.map((result) => result.id)).toEqual([given.point.qdrantId]);
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

  describe('the in-memory store, made holding the stored points', () => {
    describe("a resource's chunks, stored", () => {
      for (const { why, given } of part('resourceStored')) {
        it(why, async () => {
          const store = new MemoryVectorStore({
            resources: given.points.map((point, at) => ({
              id: point.qdrantId,
              vector: given.chunks[at].embedding,
              payload: point.payload,
            })),
            annotations: [],
          });

          for (const [at, point] of given.points.entries()) {
            expectResults(await store.searchResources(given.chunks[at].embedding, { limit: 1 }), [point.result]);
          }
        });
      }
    });

    describe('an annotation, stored', () => {
      for (const { why, given } of part('annotationStored')) {
        it(why, async () => {
          const store = new MemoryVectorStore({
            resources: [],
            annotations: [{ id: given.point.qdrantId, vector: given.embedding, payload: given.point.payload }],
          });

          expectResults(
            await store.searchAnnotations(given.embedding, { limit: 1, filter: { motivation: given.motivation } }),
            [given.point.result],
          );
        });
      }
    });
  });
});
