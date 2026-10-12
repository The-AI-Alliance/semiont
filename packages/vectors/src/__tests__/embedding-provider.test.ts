import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmbeddingProvider, deterministicVector } from '../testing';

describe('MockEmbeddingProvider', () => {
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    provider = new MockEmbeddingProvider(8);
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

  it('returns the vector deterministicVector states', async () => {
    expect(await provider.embed('hello')).toEqual(deterministicVector('hello', 8));
  });

  it('reports correct dimensions', async () => {
    expect(await provider.dimensions()).toBe(8);
  });
});
