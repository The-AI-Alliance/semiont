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

  // Write
  upsertResourceVectors(resourceId: ResourceId, chunks: EmbeddingChunk[]): Promise<void>;
  upsertAnnotationVector(annotationId: AnnotationId, embedding: number[], payload: AnnotationPayload): Promise<void>;
  deleteResourceVectors(resourceId: ResourceId): Promise<void>;
  deleteAnnotationVector(annotationId: AnnotationId): Promise<void>;

  // Read
  searchResources(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]>;
  searchAnnotations(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]>;
}
