import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockEmbeddingProvider } from './mock-embedding-provider';

describe('MockEmbeddingProvider', () => {
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    provider = new MockEmbeddingProvider(8, 'test-model');
  });

  it('returns vectors of the correct dimension', async () => {
    const vec = await provider.embed('hello');
    expect(vec).toHaveLength(8);
  });

  it('returns normalized vectors', async () => {
    const vec = await provider.embed('hello world');
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it('returns deterministic vectors for the same text', async () => {
    const vec1 = await provider.embed('hello');
    const vec2 = await provider.embed('hello');
    expect(vec1).toEqual(vec2);
  });

  it('returns different vectors for different text', async () => {
    const vec1 = await provider.embed('hello');
    const vec2 = await provider.embed('world');
    expect(vec1).not.toEqual(vec2);
  });

  it('embedBatch returns correct number of vectors', async () => {
    const vecs = await provider.embedBatch(['a', 'b', 'c']);
    expect(vecs).toHaveLength(3);
    vecs.forEach(v => expect(v).toHaveLength(8));
  });

  it('reports correct dimensions', () => {
    expect(provider.dimensions()).toBe(8);
  });

  it('reports correct model name', () => {
    expect(provider.model()).toBe('test-model');
  });
});
