/**
 * VectorStore Interface
 *
 * Abstraction over vector database backends (Qdrant, memory).
 * Stores pre-computed embedding vectors with metadata payloads
 * and provides similarity search with payload filtering.
 */

import type { ResourceId, AnnotationId } from '@semiont/core';

export interface EmbeddingChunk {
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface AnnotationPayload {
  annotationId: AnnotationId;
  resourceId: ResourceId;
  motivation: string;
  entityTypes: string[];
  exactText: string;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  resourceId: ResourceId;
  annotationId?: AnnotationId;
  text: string;
  entityTypes?: string[];
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
  isConnected(): boolean;

  // Lifecycle
  clearAll(): Promise<void>;

  // Write
  /**
   * Replace all vectors for a resource with the given chunks.
   * Existing vectors for the resource are removed first, so a resource
   * that shrinks to fewer chunks leaves no orphans. `contentChecksum` is
   * the checksum of the bytes the chunks were computed from; it is stamped
   * onto the points so reconciliation can detect stale-but-present
   * resources (SMELTER-AXIOMS.md, S12). `entityTypes` is the resource's
   * entity-type set, stamped onto every point so `searchResources` can
   * discriminate by kind (e.g. exclude `['Question']` from recall).
   */
  upsertResourceVectors(resourceId: ResourceId, chunks: EmbeddingChunk[], contentChecksum: string, entityTypes: string[]): Promise<void>;
  /**
   * Rewrite the `entityTypes` stamp on a resource's existing points —
   * payload-only, no embedding involved (SMELTER-AXIOMS.md, S13: a tag edit
   * must never trigger an embedding call). No-op when the resource has no
   * points: the stamp rides the next embed.
   */
  updateResourceEntityTypes(resourceId: ResourceId, entityTypes: string[]): Promise<void>;
  upsertAnnotationVector(annotationId: AnnotationId, embedding: number[], payload: AnnotationPayload): Promise<void>;
  deleteResourceVectors(resourceId: ResourceId): Promise<void>;
  deleteAnnotationVector(annotationId: AnnotationId): Promise<void>;
  /** Delete every annotation vector whose payload points at the resource. */
  deleteAnnotationVectorsForResource(resourceId: ResourceId): Promise<void>;

  // Read
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
  /**
   * Total point count across all collections (resources + annotations).
   * Feeds the `semiont.vector.index.size` gauge.
   */
  count(): Promise<number>;

  // Enumeration — drives the Smelter's startup reconciliation: what is
  // actually indexed (and from which content), compared against what the
  // KS says should exist.
  /**
   * Distinct resourceIds present in the resources collection, each with its
   * stamps: the content checksum (undefined for points written before
   * stamping existed — reconciliation treats those as stale and re-embeds)
   * and the entity-type set (missing stamp reads as `[]`). Drives both the
   * S12 content-staleness diff and the S13 tag-staleness diff.
   */
  listResourceStamps(): Promise<Map<string, { contentChecksum: string | undefined; entityTypes: string[] }>>;
  /** Distinct annotationIds present in the annotations collection. */
  listAnnotationIds(): Promise<Set<string>>;
}
