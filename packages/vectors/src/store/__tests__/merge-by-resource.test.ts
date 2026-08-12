/**
 * The chunk→resource max-sim merge, as a unit.
 *
 * Three callers fold chunk-level hits into one entry per resource: both
 * `searchByResource` implementations (qdrant, memory) and — once
 * SEMANTIC-FALLBACK P2 lands — the fallback's fold over raw `searchResources`
 * output, which maps one-to-one with no dedup. Three copies of one merge is the
 * redundancy the house rules forbid, so the fold lives here and they all call it.
 *
 * The invariant under test is SEMANTIC-FALLBACK axiom S7: one entry per
 * resource, however many chunks matched. The two ways to get that wrong are
 * keeping the *first* hit seen or averaging the chunks' scores — both are
 * plausible-looking folds, and both destroy the "peak relevance" property
 * max-sim exists to provide. A resource is as relevant as its best passage,
 * not as its average one.
 */

import { describe, it, expect } from 'vitest';
import { mergeByResource } from '../merge';
import type { VectorSearchResult } from '../interface';
import type { ResourceId } from '@semiont/core';

/** A chunk-level hit as a search returns it, before merging. */
function hit(resourceId: string, score: number, text: string, extra: Partial<VectorSearchResult> = {}): VectorSearchResult {
  return { id: `${resourceId}-${text}`, score, resourceId: resourceId as ResourceId, text, ...extra };
}

describe('mergeByResource', () => {
  it('folds many chunk hits into one entry per resource (S7)', () => {
    const merged = mergeByResource([
      hit('res-a', 0.9, 'a chunk 0'),
      hit('res-b', 0.7, 'b chunk 0'),
      hit('res-a', 0.5, 'a chunk 1'),
      hit('res-b', 0.6, 'b chunk 1'),
      hit('res-a', 0.4, 'a chunk 2'),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map(r => r.resourceId).sort()).toEqual(['res-a', 'res-b']);
  });

  it('keeps the MAXIMUM score of a resource\'s chunks — not the first, not the mean', () => {
    // First-seen is 0.2 and the mean is 0.4; only max-sim yields 0.8.
    const merged = mergeByResource([
      hit('res-a', 0.2, 'weak chunk'),
      hit('res-a', 0.8, 'strong chunk'),
      hit('res-a', 0.2, 'weak chunk again'),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBeCloseTo(0.8, 6);
  });

  it('carries the text of the best-scoring chunk', () => {
    const merged = mergeByResource([
      hit('res-a', 0.3, 'off-topic passage'),
      hit('res-a', 0.95, 'the passage that actually matched'),
      hit('res-a', 0.5, 'tangential passage'),
    ]);

    expect(merged[0].text).toBe('the passage that actually matched');
  });

  it('orders output by score, descending', () => {
    const merged = mergeByResource([
      hit('res-low', 0.1, 'low'),
      hit('res-high', 0.99, 'high'),
      hit('res-mid', 0.5, 'mid'),
    ]);

    expect(merged.map(r => r.resourceId)).toEqual(['res-high', 'res-mid', 'res-low']);
  });

  it('carries the winning hit\'s other fields, not a blend across chunks', () => {
    const merged = mergeByResource([
      hit('res-a', 0.2, 'weak', { entityTypes: ['Draft'], id: 'weak-id' }),
      hit('res-a', 0.8, 'strong', { entityTypes: ['Article'], id: 'strong-id', machineRead: true }),
    ]);

    expect(merged[0].id).toBe('strong-id');
    expect(merged[0].entityTypes).toEqual(['Article']);
    expect(merged[0].machineRead).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(mergeByResource([])).toEqual([]);
  });

  it('does not slice — the caller owns the limit', () => {
    const merged = mergeByResource([
      hit('res-a', 0.9, 'a'), hit('res-b', 0.8, 'b'), hit('res-c', 0.7, 'c'),
    ]);

    expect(merged).toHaveLength(3);
  });
});
