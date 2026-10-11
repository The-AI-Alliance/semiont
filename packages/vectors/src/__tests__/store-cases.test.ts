/**
 * What the vector index answers after what it was told, held to
 * specs/src/vectors/store-cases.json: the table every implementation of the
 * stores runs. Each case is a history of writes and the answer every read
 * then gives.
 *
 * The in-memory store runs every case. The Qdrant store runs none here: no
 * Qdrant is under this package's tests, and a faked client can show what the
 * store sends and not what a real Qdrant answers a search. What that store
 * sends, and what it reads of a payload, is held by payload-cases.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { annotationId, resourceId } from '@semiont/core';
import type { SearchOptions, VectorSearchResult } from '../store/interface';
import { MemoryVectorStore } from '../store/memory';

interface Chunk {
  index: number;
  text: string;
  embedding: number[];
}

type Write =
  | { write: 'resourcePut'; resourceId: string; chunks: Chunk[]; contentChecksum: string; entityTypes: string[]; machineRead?: boolean }
  | { write: 'entityTypesRewritten'; resourceId: string; entityTypes: string[] }
  | {
      write: 'annotationPut';
      annotationId: string;
      resourceId: string;
      motivation: string;
      entityTypes: string[];
      text: string;
      embedding: number[];
      machineRead?: boolean;
    }
  | { write: 'resourceDeleted'; resourceId: string }
  | { write: 'annotationDeleted'; annotationId: string }
  | { write: 'annotationsOfResourceDeleted'; resourceId: string };

interface Filter {
  entityTypes?: string[];
  resourceId?: string;
  motivation?: string;
  excludeResourceId?: string;
  excludeEntityTypes?: string[];
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

interface Search {
  limit: number;
  scoreThreshold?: number;
  filter?: Filter;
  answers: Result[];
}

type Read =
  | ({ read: 'resourcesSearched'; embedding: number[] } & Search)
  | ({ read: 'annotationsSearched'; embedding: number[] } & Search)
  | ({ read: 'searchedByResource'; resourceId: string } & Search)
  | { read: 'counted'; answers: number }
  | { read: 'stampsListed'; answers: Record<string, Stamp> }
  | { read: 'stampRead'; resourceId: string; answers?: Stamp }
  | { read: 'annotationIdsListed'; answers: string[] };

interface Case {
  why: string;
  writes: Write[];
  reads: Read[];
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/vectors/store-cases.json', import.meta.url), 'utf8'),
);

/** Every member a write, a read and a filter may state. A member that is none of these is one this runner would not read. */
const WRITE_MEMBERS: Record<Write['write'], readonly string[]> = {
  resourcePut: ['resourceId', 'chunks', 'contentChecksum', 'entityTypes', 'machineRead'],
  entityTypesRewritten: ['resourceId', 'entityTypes'],
  annotationPut: ['annotationId', 'resourceId', 'motivation', 'entityTypes', 'text', 'embedding', 'machineRead'],
  resourceDeleted: ['resourceId'],
  annotationDeleted: ['annotationId'],
  annotationsOfResourceDeleted: ['resourceId'],
};
const SEARCH_MEMBERS = ['limit', 'scoreThreshold', 'filter', 'answers'];
const READ_MEMBERS: Record<Read['read'], readonly string[]> = {
  resourcesSearched: ['embedding', ...SEARCH_MEMBERS],
  annotationsSearched: ['embedding', ...SEARCH_MEMBERS],
  searchedByResource: ['resourceId', ...SEARCH_MEMBERS],
  counted: ['answers'],
  stampsListed: ['answers'],
  stampRead: ['resourceId', 'answers'],
  annotationIdsListed: ['answers'],
};
const FILTER_MEMBERS = ['entityTypes', 'resourceId', 'motivation', 'excludeResourceId', 'excludeEntityTypes'];
const CHUNK_MEMBERS = ['index', 'text', 'embedding'];

const unread = (value: object, known: readonly string[]): string[] =>
  Object.keys(value).filter((member) => !known.includes(member));

/** How closely a score is compared: the table states one to six decimal places. */
const SCORE_TOLERANCE = 0.000001;

/** A result without its `id`, which is each store's own key, and without its score, which is compared apart. */
const stated = (result: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(result).filter(([member]) => member !== 'id' && member !== 'score'));

function expectResults(answered: VectorSearchResult[], expected: Result[], what: string): void {
  expect(answered.map(stated), what).toEqual(expected.map(stated));
  answered.forEach((result, at) => {
    expect(Math.abs(result.score - expected[at].score), `${what}: the score of result ${at}`).toBeLessThanOrEqual(SCORE_TOLERANCE);
  });
}

async function write(store: MemoryVectorStore, given: Write): Promise<void> {
  switch (given.write) {
    case 'resourcePut':
      return store.upsertResourceVectors(
        resourceId(given.resourceId),
        given.chunks.map(({ index, text, embedding }) => ({ chunkIndex: index, text, embedding })),
        given.contentChecksum,
        given.entityTypes,
        given.machineRead,
      );
    case 'entityTypesRewritten':
      return store.updateResourceEntityTypes(resourceId(given.resourceId), given.entityTypes);
    case 'annotationPut':
      return store.upsertAnnotationVector(annotationId(given.annotationId), given.embedding, {
        annotationId: annotationId(given.annotationId),
        resourceId: resourceId(given.resourceId),
        motivation: given.motivation,
        entityTypes: given.entityTypes,
        exactText: given.text,
        machineRead: given.machineRead,
      });
    case 'resourceDeleted':
      return store.deleteResourceVectors(resourceId(given.resourceId));
    case 'annotationDeleted':
      return store.deleteAnnotationVector(annotationId(given.annotationId));
    case 'annotationsOfResourceDeleted':
      return store.deleteAnnotationVectorsForResource(resourceId(given.resourceId));
    default:
      throw new Error(`a write this runner does not know: ${JSON.stringify(given)}`);
  }
}

function options({ limit, scoreThreshold, filter }: Search): SearchOptions {
  return {
    limit,
    scoreThreshold,
    filter: filter && {
      entityTypes: filter.entityTypes,
      resourceId: filter.resourceId === undefined ? undefined : resourceId(filter.resourceId),
      motivation: filter.motivation,
      excludeResourceId: filter.excludeResourceId === undefined ? undefined : resourceId(filter.excludeResourceId),
      excludeEntityTypes: filter.excludeEntityTypes,
    },
  };
}

async function expectAnswer(store: MemoryVectorStore, given: Read, what: string): Promise<void> {
  switch (given.read) {
    case 'resourcesSearched':
      return expectResults(await store.searchResources(given.embedding, options(given)), given.answers, what);
    case 'annotationsSearched':
      return expectResults(await store.searchAnnotations(given.embedding, options(given)), given.answers, what);
    case 'searchedByResource':
      return expectResults(await store.searchByResource(resourceId(given.resourceId), options(given)), given.answers, what);
    case 'counted':
      return expect(await store.count(), what).toBe(given.answers);
    case 'stampsListed':
      return expect(Object.fromEntries(await store.listResourceStamps()), what).toEqual(given.answers);
    case 'stampRead':
      return expect(await store.getResourceStamp(resourceId(given.resourceId)), what).toEqual(given.answers);
    case 'annotationIdsListed':
      return expect([...(await store.listAnnotationIds())].sort(), what).toEqual([...given.answers].sort());
    default:
      throw new Error(`a read this runner does not know: ${JSON.stringify(given)}`);
  }
}

describe('what the vector index answers after a history of writes (specs/src/vectors/store-cases.json)', () => {
  it('has cases, and no write, read or member this runner would not run', () => {
    expect(table.cases.length).toBeGreaterThan(0);
    for (const c of table.cases) {
      expect(unread(c, ['why', 'writes', 'reads']), c.why).toEqual([]);
      for (const given of c.writes) {
        expect(Object.keys(WRITE_MEMBERS), c.why).toContain(given.write);
        expect(unread(given, ['write', ...WRITE_MEMBERS[given.write]]), `${c.why}: ${given.write}`).toEqual([]);
        if (given.write === 'resourcePut') {
          for (const chunk of given.chunks) expect(unread(chunk, CHUNK_MEMBERS), c.why).toEqual([]);
        }
      }
      for (const given of c.reads) {
        expect(Object.keys(READ_MEMBERS), c.why).toContain(given.read);
        expect(unread(given, ['read', ...READ_MEMBERS[given.read]]), `${c.why}: ${given.read}`).toEqual([]);
        if (given.read !== 'stampRead') expect(given, `${c.why}: ${given.read}`).toHaveProperty('answers');
        if ('filter' in given && given.filter) expect(unread(given.filter, FILTER_MEMBERS), `${c.why}: ${given.read}`).toEqual([]);
      }
    }
  });

  it('has a history with each kind of write, and a case with each kind of read', () => {
    const writes = new Set(table.cases.flatMap((c) => c.writes.map((given) => given.write)));
    const reads = new Set(table.cases.flatMap((c) => c.reads.map((given) => given.read)));
    expect([...writes].sort()).toEqual(Object.keys(WRITE_MEMBERS).sort());
    expect([...reads].sort()).toEqual(Object.keys(READ_MEMBERS).sort());
  });

  describe('the in-memory store', () => {
    for (const { why, writes, reads } of table.cases) {
      it(why, async () => {
        const store = new MemoryVectorStore();
        for (const given of writes) await write(store, given);
        for (const [at, given] of reads.entries()) await expectAnswer(store, given, `read ${at}, ${given.read}`);
      });
    }
  });
});
