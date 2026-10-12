import { describe, it, expect } from 'vitest';
import { MemoryVectorStore, type MemoryPoint } from '../store/memory';
import { deterministicVector } from '../testing';
import type { ResourceId } from '@semiont/core';

/** The vector these tests give a text: reproducible, so a search by a text's own vector scores 1. */
const vectorOf = (text: string): number[] => deterministicVector(text, 8);

/** A chunk of a resource, as a point of the resources collection. */
function chunk(
  resourceId: string,
  chunkIndex: number,
  text: string,
  vector: number[],
  stated: { entityTypes?: string[]; machineRead?: true } = {},
): MemoryPoint {
  return {
    id: `${resourceId}-${chunkIndex}`,
    vector,
    payload: {
      resourceId,
      chunkIndex,
      text,
      contentChecksum: `cs-${resourceId}`,
      entityTypes: stated.entityTypes ?? [],
      ...(stated.machineRead ? { machineRead: true } : {}),
    },
  };
}

/** An annotation, as a point of the annotations collection. */
function annotation(
  annotationId: string,
  resourceId: string,
  text: string,
  stated: { motivation?: string; entityTypes?: string[]; machineRead?: true } = {},
): MemoryPoint {
  return {
    id: annotationId,
    vector: vectorOf(text),
    payload: {
      annotationId,
      resourceId,
      motivation: stated.motivation ?? 'highlighting',
      entityTypes: stated.entityTypes ?? [],
      text,
      ...(stated.machineRead ? { machineRead: true } : {}),
    },
  };
}

const holding = (held: { resources?: MemoryPoint[]; annotations?: MemoryPoint[] }): MemoryVectorStore =>
  new MemoryVectorStore({ resources: held.resources ?? [], annotations: held.annotations ?? [] });

describe('MemoryVectorStore', () => {
  describe('resource vectors', () => {
    it('searches the points it was made holding', async () => {
      const text = 'Abraham Lincoln was the 16th president';
      const store = holding({ resources: [chunk('res-1', 0, text, vectorOf(text))] });

      const results = await store.searchResources(vectorOf(text), { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('res-1');
      expect(results[0].score).toBeCloseTo(1.0, 3); // exact match
      expect(results[0].text).toBe(text);
    });

    it('carries the machine-read stamp back out of search', async () => {
      // Provenance for text no human or native extractor produced: OCR read it
      // off pixels. Nothing downstream can recompute that — the chunk reaches
      // its consumers (LLM prompts) with no document attached — so the
      // projection that carries the text carries the fact.
      const text = 'recovered from a scan';
      const store = holding({ resources: [chunk('res-scan', 0, text, vectorOf(text), { machineRead: true })] });

      const [result] = await store.searchResources(vectorOf(text), { limit: 5 });
      expect(result!.machineRead).toBe(true);
    });

    it('leaves the stamp off text that was read directly', async () => {
      const text = 'typed by a person';
      const store = holding({ resources: [chunk('res-native', 0, text, vectorOf(text))] });

      const [result] = await store.searchResources(vectorOf(text), { limit: 5 });
      expect(result!.machineRead).toBeUndefined();
    });

    it('handles multiple chunks per resource', async () => {
      const texts = ['chunk one', 'chunk two', 'chunk three'];
      const store = holding({ resources: texts.map((text, at) => chunk('res-1', at, text, vectorOf(text))) });

      const results = await store.searchResources(vectorOf('chunk one'), { limit: 10 });
      expect(results.length).toBe(3);
      expect(results[0].text).toBe('chunk one'); // best match
    });
  });

  describe('resource entity-type discrimination', () => {
    const question = 'What is the capital of France?';
    const article = 'Paris is the capital of France.';

    it('answers the entityTypes a point carries', async () => {
      const store = holding({ resources: [chunk('q-1', 0, question, vectorOf(question), { entityTypes: ['Question'] })] });

      const results = await store.searchResources(vectorOf(question), { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].entityTypes).toEqual(['Question']);
    });

    it('excludes resources whose entityTypes intersect excludeEntityTypes', async () => {
      const store = holding({
        resources: [
          chunk('q-1', 0, question, vectorOf(question), { entityTypes: ['Question'] }),
          chunk('doc-1', 0, article, vectorOf(article), { entityTypes: ['Article'] }),
        ],
      });

      // Query closest to the question itself, but questions must drop out of recall.
      const results = await store.searchResources(vectorOf(question), {
        limit: 10,
        filter: { excludeEntityTypes: ['Question'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('doc-1');
    });

    it('keeps resources when excludeEntityTypes does not intersect', async () => {
      const store = holding({ resources: [chunk('doc-1', 0, article, vectorOf(article), { entityTypes: ['Article'] })] });

      const results = await store.searchResources(vectorOf(article), {
        limit: 10,
        filter: { excludeEntityTypes: ['Question'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('doc-1');
    });
  });

  describe('searchByResource (per-chunk max-sim)', () => {
    it('returns empty when the resource has no stored vectors', async () => {
      const results = await holding({}).searchByResource('ghost' as ResourceId, { limit: 10 });
      expect(results).toEqual([]);
    });

    it('finds resources similar to the source, excluding the source and excluded kinds', async () => {
      const store = holding({
        resources: [
          chunk('q-1', 0, 'capital of France?', [1, 0, 0], { entityTypes: ['Question'] }),
          chunk('q-2', 0, 'capital of France?', [1, 0, 0], { entityTypes: ['Question'] }),
          chunk('doc-paris', 0, 'Paris is the capital', [0.9, 0.1, 0], { entityTypes: ['Article'] }),
          chunk('doc-berlin', 0, 'Berlin is the capital', [0, 1, 0], { entityTypes: ['Article'] }),
        ],
      });

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
      const store = holding({
        resources: [
          // Source has two orthogonal-topic chunks.
          chunk('multi', 0, 'quantum', [1, 0]),
          chunk('multi', 1, 'cooking', [0, 1]),
          // Each doc strongly matches ONE chunk; 'mid' matches the average of both.
          chunk('doc-quantum', 0, 'quantum doc', [1, 0], { entityTypes: ['Article'] }),
          chunk('doc-cooking', 0, 'cooking doc', [0, 1], { entityTypes: ['Article'] }),
          chunk('doc-mid', 0, 'mid doc', [0.7071, 0.7071], { entityTypes: ['Article'] }),
        ],
      });

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
      const store = holding({
        resources: [
          chunk('src', 0, 'q', [1, 0]),
          chunk('doc', 0, 'off-topic chunk', [0, 1], { entityTypes: ['Article'] }),
          chunk('doc', 1, 'on-topic chunk', [1, 0], { entityTypes: ['Article'] }),
        ],
      });

      const results = await store.searchByResource('src' as ResourceId, { limit: 10 });
      const docResults = results.filter(r => r.resourceId === 'doc');
      expect(docResults).toHaveLength(1);                 // deduped to one
      expect(docResults[0].score).toBeCloseTo(1.0, 3);    // best chunk's score
      expect(docResults[0].text).toBe('on-topic chunk');  // best-matching chunk's text
    });
  });

  describe('annotation vectors', () => {
    it('searches the annotations it was made holding', async () => {
      const text = 'Lincoln delivered the Gettysburg Address';
      const store = holding({ annotations: [annotation('ann-1', 'res-1', text, { entityTypes: ['Person'] })] });

      const results = await store.searchAnnotations(vectorOf(text), { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0].annotationId).toBe('ann-1');
      expect(results[0].resourceId).toBe('res-1');
      expect(results[0].entityTypes).toEqual(['Person']);
    });

    it('carries the machine-read stamp on an annotation too', async () => {
      // An annotation over a scanned page quotes OCR'd text, and
      // annotation-focus gather searches THESE vectors — so the flag has to
      // ride here as well, or half the gather paths lose it silently.
      const text = 'recognized from a scan';
      const store = holding({ annotations: [annotation('ann-scan', 'res-scan', text, { machineRead: true })] });

      const [result] = await store.searchAnnotations(vectorOf(text), { limit: 5 });
      expect(result!.machineRead).toBe(true);
    });

    it('keeps the two collections apart', async () => {
      const text = 'in one collection only';
      const store = holding({ annotations: [annotation('ann-1', 'res-1', text)] });

      expect(await store.searchResources(vectorOf(text), { limit: 5 })).toEqual([]);
    });
  });

  describe('filtering', () => {
    // Two annotations with different entity types and motivations.
    const store = holding({
      annotations: [
        annotation('ann-1', 'res-1', 'Lincoln was a president', { motivation: 'highlighting', entityTypes: ['Person'] }),
        annotation('ann-2', 'res-2', 'Washington DC is the capital', { motivation: 'linking', entityTypes: ['Place'] }),
      ],
    });

    it('filters by entity type', async () => {
      const results = await store.searchAnnotations(vectorOf('a person'), {
        limit: 10,
        filter: { entityTypes: ['Person'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].annotationId).toBe('ann-1');
    });

    it('filters by motivation', async () => {
      const results = await store.searchAnnotations(vectorOf('something'), {
        limit: 10,
        filter: { motivation: 'linking' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].annotationId).toBe('ann-2');
    });

    it('filters by resourceId', async () => {
      const results = await store.searchAnnotations(vectorOf('something'), {
        limit: 10,
        filter: { resourceId: 'res-1' as ResourceId },
      });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('res-1');
    });

    it('excludes by resourceId', async () => {
      const results = await store.searchAnnotations(vectorOf('something'), {
        limit: 10,
        filter: { excludeResourceId: 'res-1' as ResourceId },
      });
      expect(results).toHaveLength(1);
      expect(results[0].resourceId).toBe('res-2');
    });

    it('applies score threshold', async () => {
      const results = await store.searchAnnotations(vectorOf('Lincoln was a president'), { // exact match for ann-1
        limit: 10,
        scoreThreshold: 0.99, // only exact matches
      });
      expect(results).toHaveLength(1);
      expect(results[0].annotationId).toBe('ann-1');
    });

    it('limits results', async () => {
      const results = await store.searchAnnotations(vectorOf('something'), { limit: 1 });
      expect(results).toHaveLength(1);
    });
  });
});
