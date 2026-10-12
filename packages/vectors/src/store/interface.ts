/**
 * VectorStore Interface
 *
 * The vector index, as a reader of it reads it: similarity search over the
 * chunks of resources and over annotations, with payload filtering. Every
 * store answers these.
 *
 * Nothing here writes a point. The one writer of the index is the Smelter, a
 * Python service that writes through `semiont_vectors`
 * (packages/vectors-python).
 */

import type { ResourceId, AnnotationId } from '@semiont/core';

export interface VectorSearchResult {
  id: string;
  score: number;
  resourceId: ResourceId;
  annotationId?: AnnotationId;
  text: string;
  entityTypes?: string[];
  /**
   * Set when this passage's text was recognized from pixels rather than read
   * from the document. Absent means read directly — the common case — so the
   * flag is only ever present where it changes how the text should be
   * trusted. Carried here because a chunk reaches its consumers with no
   * document attached, and no consumer can recompute it.
   */
  machineRead?: boolean;
}

export interface SearchOptions {
  limit: number;
  scoreThreshold?: number;
  filter?: {
    entityTypes?: string[];
    resourceId?: ResourceId;
    motivation?: string;
    excludeResourceId?: ResourceId;
    /**
     * Drop any point whose `entityTypes` intersect this set (any-of exclusion,
     * the mirror of `entityTypes`). Lets a caller exclude a whole structural
     * kind from recall — e.g. `['Question']` so answer-generation retrieval
     * never surfaces prior questions.
     */
    excludeEntityTypes?: string[];
  };
}

export interface VectorStore {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  searchResources(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]>;
  searchAnnotations(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]>;
  /**
   * Find resources similar to a resource's own stored chunk vectors ("more like
   * this resource"), without re-embedding any text.
   *
   * Per-chunk top-K + **max-sim merge** (not a centroid/average): searches by
   * each of the resource's stored chunk vectors, then merges by `resourceId`
   * keeping the **maximum** similarity any query chunk had to any target chunk.
   * Each result's `score` is that max and its `text` is the best-matching target
   * chunk, so callers see the passage that matched. The source resource's own
   * points are excluded; `opts.filter.excludeEntityTypes` drops excluded kinds.
   *
   * Returns `[]` if the resource has no stored vectors yet (it must be indexed
   * first — callers own that ordering).
   */
  searchByResource(resourceId: ResourceId, opts: SearchOptions): Promise<VectorSearchResult[]>;
}
