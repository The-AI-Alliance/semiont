/**
 * Chunk→resource max-sim merge.
 *
 * Vector search returns *chunk*-level hits: one resource can match on several
 * of its chunks, and a caller that wants a list of resources has to fold them.
 * The fold is max-sim (late interaction): a resource scores as its single
 * best-matching chunk, and carries that chunk's text — so the caller can show
 * the passage that actually matched. Averaging instead would blur a
 * multi-topic resource into a vague centroid and lose which passage hit;
 * keeping the first hit seen would make the result order-dependent.
 *
 * Three callers share this: both `searchByResource` implementations (qdrant
 * batches one query per source chunk; memory scores every candidate against
 * every source chunk) and the SEMANTIC-FALLBACK fold over raw `searchResources`
 * output, whose hits map one-to-one with no dedup. All three normalise to
 * `VectorSearchResult[]` first, so this fold is the only copy of the logic.
 *
 * Deliberately does NOT slice to a limit: `searchByResource` and the fallback
 * want different slices, and a fold that silently truncates is the kind of
 * hidden cap that reads as "covered everything" when it didn't.
 */

import type { VectorSearchResult } from './interface';

/**
 * Fold chunk-level hits to one entry per resource — the highest-scoring chunk
 * wins, carrying its own text and metadata — sorted score-descending.
 */
export function mergeByResource(hits: VectorSearchResult[]): VectorSearchResult[] {
  const bestByResource = new Map<string, VectorSearchResult>();

  for (const hit of hits) {
    const key = String(hit.resourceId);
    const prev = bestByResource.get(key);
    if (!prev || hit.score > prev.score) bestByResource.set(key, hit);
  }

  return [...bestByResource.values()].sort((a, b) => b.score - a.score);
}
