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
    it('lists distinct resource ids with their stamped checksums', async () => {
      const vecs = await embedding.embedBatch(['alpha', 'beta']);
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'alpha', embedding: vecs[0] },
      ], 'cs-alpha', []);
      await store.upsertResourceVectors('res-2' as ResourceId, [
        { chunkIndex: 0, text: 'beta', embedding: vecs[1] },
      ], 'cs-beta', []);

      expect(await store.listResourceChecksums()).toEqual(new Map([
        ['res-1', 'cs-alpha'],
        ['res-2', 'cs-beta'],
      ]));
    });

    it('re-upsert replaces the stamped checksum', async () => {
      const vec = await embedding.embed('gamma');
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'gamma', embedding: vec },
      ], 'cs-old', []);
      await store.upsertResourceVectors('res-1' as ResourceId, [
        { chunkIndex: 0, text: 'gamma', embedding: vec },
      ], 'cs-new', []);

      expect((await store.listResourceChecksums()).get('res-1')).toBe('cs-new');
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
