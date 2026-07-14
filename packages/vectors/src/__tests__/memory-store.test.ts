import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryVectorStore } from '../store/memory';
import { MockEmbeddingProvider } from './mock-embedding-provider';
import type { ResourceId, AnnotationId } from '@semiont/core';

describe('MemoryVectorStore', () => {
  let store: MemoryVectorStore;
  let embedding: MockEmbeddingProvider;

  beforeEach(async () => {
    store = new MemoryVectorStore();
    await store.connect();
    embedding = new MockEmbeddingProvider(8); // small dims for tests
  });

  describe('connection', () => {
    it('reports connected after connect()', () => {
      expect(store.isConnected()).toBe(true);
    });

    it('reports disconnected after disconnect()', async () => {
      await store.disconnect();
      expect(store.isConnected()).toBe(false);
    });
  });

  describe('resource vectors', () => {
    it('upserts and searches resource vectors', async () => {
      const vec = await embedding.embed('Abraham Lincoln was the 16th president');
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'Abraham Lincoln was the 16th president', embedding: vec },
      ], 'cs-lincoln', []);

      const results = await store.searchResources(vec, { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('res-1');
      expect(results[0].score).toBeCloseTo(1.0, 3); // exact match
      expect(results[0].text).toBe('Abraham Lincoln was the 16th president');
    });

    it('replaces existing vectors on re-upsert', async () => {
      const vec1 = await embedding.embed('original text');
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'original text', embedding: vec1 },
      ], 'cs-v1', []);

      const vec2 = await embedding.embed('updated text');
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'updated text', embedding: vec2 },
      ], 'cs-v2', []);

      const results = await store.searchResources(vec2, { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe('updated text');
    });

    it('deletes resource vectors', async () => {
      const vec = await embedding.embed('some text');
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'some text', embedding: vec },
      ], 'cs-some', []);

      await store.deleteResourceVectors('res-1' as ResourceId);

      const results = await store.searchResources(vec, { limit: 5 });
      expect(results).toHaveLength(0);
    });

    it('handles multiple chunks per resource', async () => {
      const vecs = await embedding.embedBatch(['chunk one', 'chunk two', 'chunk three']);
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'chunk one', embedding: vecs[0] },
        { chunkIndex: 1, text: 'chunk two', embedding: vecs[1] },
        { chunkIndex: 2, text: 'chunk three', embedding: vecs[2] },
      ], 'cs-chunks', []);

      const results = await store.searchResources(vecs[0], { limit: 10 });
      expect(results.length).toBe(3);
      expect(results[0].text).toBe('chunk one'); // best match
    });
  });

  describe('resource entity-type discrimination', () => {
    it('stamps entityTypes onto resource vectors', async () => {
      const vec = await embedding.embed('What is the capital of France?');
      await store.upsertResourceVectors('q-1' as ResourceId, [
        { chunkIndex: 0, text: 'What is the capital of France?', embedding: vec },
      ], 'cs-q1', ['Question']);

      const results = await store.searchResources(vec, { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].entityTypes).toEqual(['Question']);
    });

    it('excludes resources whose entityTypes intersect excludeEntityTypes', async () => {
      const qVec = await embedding.embed('What is the capital of France?');
      await store.upsertResourceVectors('q-1' as ResourceId, [
        { chunkIndex: 0, text: 'What is the capital of France?', embedding: qVec },
      ], 'cs-q1', ['Question']);

      const dVec = await embedding.embed('Paris is the capital of France.');
      await store.upsertResourceVectors('doc-1' as ResourceId, [
        { chunkIndex: 0, text: 'Paris is the capital of France.', embedding: dVec },
      ], 'cs-doc1', ['Article']);

      // Query closest to the question itself, but questions must drop out of recall.
      const results = await store.searchResources(qVec, {
        limit: 10,
        filter: { excludeEntityTypes: ['Question'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('doc-1');
    });

    it('keeps resources when excludeEntityTypes does not intersect', async () => {
      const vec = await embedding.embed('Paris is the capital of France.');
      await store.upsertResourceVectors('doc-1' as ResourceId, [
        { chunkIndex: 0, text: 'Paris is the capital of France.', embedding: vec },
      ], 'cs-doc1', ['Article']);

      const results = await store.searchResources(vec, {
        limit: 10,
        filter: { excludeEntityTypes: ['Question'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('doc-1');
    });
  });

  describe('searchByResource (per-chunk max-sim)', () => {
    it('returns empty when the resource has no stored vectors', async () => {
      const results = await store.searchByResource('ghost' as ResourceId, { limit: 10 });
      expect(results).toEqual([]);
    });

    it('finds resources similar to the source, excluding the source and excluded kinds', async () => {
      await store.upsertResourceVectors('q-1' as ResourceId,
        [{ chunkIndex: 0, text: 'capital of France?', embedding: [1, 0, 0] }], 'cs', ['Question']);
      await store.upsertResourceVectors('q-2' as ResourceId,
        [{ chunkIndex: 0, text: 'capital of France?', embedding: [1, 0, 0] }], 'cs', ['Question']);
      await store.upsertResourceVectors('doc-paris' as ResourceId,
        [{ chunkIndex: 0, text: 'Paris is the capital', embedding: [0.9, 0.1, 0] }], 'cs', ['Article']);
      await store.upsertResourceVectors('doc-berlin' as ResourceId,
        [{ chunkIndex: 0, text: 'Berlin is the capital', embedding: [0, 1, 0] }], 'cs', ['Article']);

      const results = await store.searchByResource('q-1' as ResourceId, {
        limit: 10,
        filter: { excludeEntityTypes: ['Question'] },
      });
      const ids = results.map(r => r.resourceId);
      expect(ids).not.toContain('q-1');  // source self-excluded
      expect(ids).not.toContain('q-2');  // Question excluded
      expect(ids).toContain('doc-paris');
      expect(results[0].resourceId).toBe('doc-paris'); // most similar first
    });

    it('uses per-chunk max similarity, not a centroid average', async () => {
      // Source has two orthogonal-topic chunks.
      await store.upsertResourceVectors('multi' as ResourceId, [
        { chunkIndex: 0, text: 'quantum', embedding: [1, 0] },
        { chunkIndex: 1, text: 'cooking', embedding: [0, 1] },
      ], 'cs', []);
      // Each doc strongly matches ONE chunk; 'mid' matches the average of both.
      await store.upsertResourceVectors('doc-quantum' as ResourceId,
        [{ chunkIndex: 0, text: 'quantum doc', embedding: [1, 0] }], 'cs', ['Article']);
      await store.upsertResourceVectors('doc-cooking' as ResourceId,
        [{ chunkIndex: 0, text: 'cooking doc', embedding: [0, 1] }], 'cs', ['Article']);
      await store.upsertResourceVectors('doc-mid' as ResourceId,
        [{ chunkIndex: 0, text: 'mid doc', embedding: [0.7071, 0.7071] }], 'cs', ['Article']);

      const results = await store.searchByResource('multi' as ResourceId, { limit: 10 });
      const score = (id: string) => results.find(r => r.resourceId === id)!.score;

      // Max-sim: each single-topic doc peaks at 1.0 on its chunk; 'mid' peaks at ~0.707.
      expect(score('doc-quantum')).toBeCloseTo(1.0, 3);
      expect(score('doc-cooking')).toBeCloseTo(1.0, 3);
      expect(score('doc-mid')).toBeCloseTo(0.7071, 3);
      // A centroid query would rank 'mid' top; max-sim ranks it last.
      expect(results[results.length - 1].resourceId).toBe('doc-mid');
    });

    it('dedups multi-chunk targets to one result carrying the best-matching chunk', async () => {
      await store.upsertResourceVectors('src' as ResourceId,
        [{ chunkIndex: 0, text: 'q', embedding: [1, 0] }], 'cs', []);
      await store.upsertResourceVectors('doc' as ResourceId, [
        { chunkIndex: 0, text: 'off-topic chunk', embedding: [0, 1] },
        { chunkIndex: 1, text: 'on-topic chunk', embedding: [1, 0] },
      ], 'cs', ['Article']);

      const results = await store.searchByResource('src' as ResourceId, { limit: 10 });
      const docResults = results.filter(r => r.resourceId === 'doc');
      expect(docResults).toHaveLength(1);                 // deduped to one
      expect(docResults[0].score).toBeCloseTo(1.0, 3);    // best chunk's score
      expect(docResults[0].text).toBe('on-topic chunk');  // best-matching chunk's text
    });
  });

  describe('annotation vectors', () => {
    it('upserts and searches annotation vectors', async () => {
      const vec = await embedding.embed('Lincoln delivered the Gettysburg Address');
      await store.upsertAnnotationVector('ann-1' as AnnotationId, vec, {
        annotationId: 'ann-1' as AnnotationId,
        resourceId: 'res-1' as ResourceId,
        motivation: 'highlighting',
        entityTypes: ['Person'],
        exactText: 'Lincoln delivered the Gettysburg Address',
      });

      const results = await store.searchAnnotations(vec, { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].annotationId).toBe('ann-1');
      expect(results[0].resourceId).toBe('res-1');
      expect(results[0].entityTypes).toEqual(['Person']);
    });

    it('deletes annotation vectors', async () => {
      const vec = await embedding.embed('some annotation');
      await store.upsertAnnotationVector('ann-1' as AnnotationId, vec, {
        annotationId: 'ann-1' as AnnotationId,
        resourceId: 'res-1' as ResourceId,
        motivation: 'highlighting',
        entityTypes: [],
        exactText: 'some annotation',
      });

      await store.deleteAnnotationVector('ann-1' as AnnotationId);

      const results = await store.searchAnnotations(vec, { limit: 5 });
      expect(results).toHaveLength(0);
    });
  });

  describe('count', () => {
    it('counts points across resources and annotations', async () => {
      expect(await store.count()).toBe(0);

      const vecs = await embedding.embedBatch(['chunk one', 'chunk two']);
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'chunk one', embedding: vecs[0] },
        { chunkIndex: 1, text: 'chunk two', embedding: vecs[1] },
      ], 'cs-count', []);

      const annVec = await embedding.embed('an annotation');
      await store.upsertAnnotationVector('ann-1' as AnnotationId, annVec, {
        annotationId: 'ann-1' as AnnotationId,
        resourceId: 'res-1' as ResourceId,
        motivation: 'highlighting',
        entityTypes: [],
        exactText: 'an annotation',
      });

      expect(await store.count()).toBe(3);

      await store.deleteResourceVectors('res-1' as ResourceId);
      expect(await store.count()).toBe(1);
    });
  });

  describe('enumeration', () => {
    it('lists distinct resource ids with their stamps (checksum + entity types)', async () => {
      const vecs = await embedding.embedBatch(['alpha', 'beta']);
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'alpha', embedding: vecs[0] },
      ], 'cs-alpha', ['Question']);
      await store.upsertResourceVectors('res-2' as ResourceId, [
        { chunkIndex: 0, text: 'beta', embedding: vecs[1] },
      ], 'cs-beta', []);

      expect(await store.listResourceStamps()).toEqual(new Map([
        ['res-1', { contentChecksum: 'cs-alpha', entityTypes: ['Question'] }],
        ['res-2', { contentChecksum: 'cs-beta', entityTypes: [] }],
      ]));
    });

    it('re-upsert replaces the stamps', async () => {
      const vec = await embedding.embed('gamma');
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'gamma', embedding: vec },
      ], 'cs-old', ['OldTag']);
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'gamma', embedding: vec },
      ], 'cs-new', ['NewTag']);

      expect((await store.listResourceStamps()).get('res-1')).toEqual({
        contentChecksum: 'cs-new',
        entityTypes: ['NewTag'],
      });
    });

    it('updateResourceEntityTypes restamps every point without touching vectors', async () => {
      const vec = await embedding.embed('delta');
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'delta', embedding: vec },
      ], 'cs-delta', []);

      await store.updateResourceEntityTypes('res-1' as ResourceId, ['Question']);

      expect((await store.listResourceStamps()).get('res-1')).toEqual({
        contentChecksum: 'cs-delta',
        entityTypes: ['Question'],
      });
      // The stamp is the filter discriminator: exclusion now drops the resource…
      expect(await store.searchResources(vec, { limit: 5, filter: { excludeEntityTypes: ['Question'] } })).toEqual([]);
      // …while the vectors themselves are untouched and still searchable.
      const results = await store.searchResources(vec, { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].score).toBeCloseTo(1.0, 3);
    });

    it('updateResourceEntityTypes on an unindexed resource is a no-op', async () => {
      await store.updateResourceEntityTypes('res-ghost' as ResourceId, ['Question']);
      expect((await store.listResourceStamps()).has('res-ghost')).toBe(false);
    });
  });

  describe('filtering', () => {
    beforeEach(async () => {
      // Set up two annotations with different entity types and motivations
      const vec1 = await embedding.embed('Lincoln was a president');
      await store.upsertAnnotationVector('ann-1' as AnnotationId, vec1, {
        annotationId: 'ann-1' as AnnotationId,
        resourceId: 'res-1' as ResourceId,
        motivation: 'highlighting',
        entityTypes: ['Person'],
        exactText: 'Lincoln was a president',
      });

      const vec2 = await embedding.embed('Washington DC is the capital');
      await store.upsertAnnotationVector('ann-2' as AnnotationId, vec2, {
        annotationId: 'ann-2' as AnnotationId,
        resourceId: 'res-2' as ResourceId,
        motivation: 'linking',
        entityTypes: ['Place'],
        exactText: 'Washington DC is the capital',
      });
    });

    it('filters by entity type', async () => {
      const queryVec = await embedding.embed('a person');
      const results = await store.searchAnnotations(queryVec, {
        limit: 10,
        filter: { entityTypes: ['Person'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].annotationId).toBe('ann-1');
    });

    it('filters by motivation', async () => {
      const queryVec = await embedding.embed('something');
      const results = await store.searchAnnotations(queryVec, {
        limit: 10,
        filter: { motivation: 'linking' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].annotationId).toBe('ann-2');
    });

    it('filters by resourceId', async () => {
      const queryVec = await embedding.embed('something');
      const results = await store.searchAnnotations(queryVec, {
        limit: 10,
        filter: { resourceId: 'res-1' as ResourceId },
      });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('res-1');
    });

    it('excludes by resourceId', async () => {
      const queryVec = await embedding.embed('something');
      const results = await store.searchAnnotations(queryVec, {
        limit: 10,
        filter: { excludeResourceId: 'res-1' as ResourceId },
      });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('res-2');
    });

    it('applies score threshold', async () => {
      const queryVec = await embedding.embed('Lincoln was a president'); // exact match for ann-1
      const results = await store.searchAnnotations(queryVec, {
        limit: 10,
        scoreThreshold: 0.99, // only exact matches
      });
      expect(results).toHaveLength(1);
      expect(results[0].annotationId).toBe('ann-1');
    });

    it('limits results', async () => {
      const queryVec = await embedding.embed('something');
      const results = await store.searchAnnotations(queryVec, { limit: 1 });
      expect(results).toHaveLength(1);
    });
  });
});
