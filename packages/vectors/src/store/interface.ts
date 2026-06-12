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
   * resources (SMELTER-AXIOMS.md, S12).
   */
  upsertResourceVectors(resourceId: ResourceId, chunks: EmbeddingChunk[], contentChecksum: string): Promise<void>;
  upsertAnnotationVector(annotationId: AnnotationId, embedding: number[], payload: AnnotationPayload): Promise<void>;
  deleteResourceVectors(resourceId: ResourceId): Promise<void>;
  deleteAnnotationVector(annotationId: AnnotationId): Promise<void>;
  /** Delete every annotation vector whose payload points at the resource. */
  deleteAnnotationVectorsForResource(resourceId: ResourceId): Promise<void>;

  // Read
  searchResources(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]>;
  searchAnnotations(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]>;
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
   * stamped content checksum (undefined for points written before stamping
   * existed — reconciliation treats those as stale and re-embeds them).
   */
  listResourceChecksums(): Promise<Map<string, string | undefined>>;
  /** Distinct annotationIds present in the annotations collection. */
  listAnnotationIds(): Promise<Set<string>>;
}
