/**
 * In-Memory VectorStore Implementation
 *
 * For testing and development without a running Qdrant instance.
 * Uses brute-force cosine similarity search.
 */

import type { ResourceId, AnnotationId } from '@semiont/core';
import type { VectorStore, EmbeddingChunk, AnnotationPayload, VectorSearchResult, SearchOptions } from './interface';

interface StoredPoint {
  id: string;
  vector: number[];
  payload: {
    resourceId: string;
    annotationId?: string;
    chunkIndex?: number;
    text: string;
    motivation?: string;
    entityTypes?: string[];
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

export class MemoryVectorStore implements VectorStore {
  private resources: StoredPoint[] = [];
  private annotations: StoredPoint[] = [];
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async upsertResourceVectors(resourceId: ResourceId, chunks: EmbeddingChunk[]): Promise<void> {
    // Remove existing vectors for this resource
    this.resources = this.resources.filter(p => p.payload.resourceId !== String(resourceId));

    for (const chunk of chunks) {
      this.resources.push({
        id: `${resourceId}-${chunk.chunkIndex}`,
        vector: chunk.embedding,
        payload: {
          resourceId: String(resourceId),
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
        },
      });
    }
  }

  async upsertAnnotationVector(
    annotationId: AnnotationId,
    embedding: number[],
    payload: AnnotationPayload
  ): Promise<void> {
    this.annotations = this.annotations.filter(p => p.id !== String(annotationId));
    this.annotations.push({
      id: String(annotationId),
      vector: embedding,
      payload: {
        annotationId: String(payload.annotationId),
        resourceId: String(payload.resourceId),
        motivation: payload.motivation,
        entityTypes: payload.entityTypes,
        text: payload.exactText,
      },
    });
  }

  async deleteResourceVectors(resourceId: ResourceId): Promise<void> {
    this.resources = this.resources.filter(p => p.payload.resourceId !== String(resourceId));
  }

  async deleteAnnotationVector(annotationId: AnnotationId): Promise<void> {
    this.annotations = this.annotations.filter(p => p.id !== String(annotationId));
  }

  async searchResources(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    return this.search(this.resources, embedding, opts);
  }

  async searchAnnotations(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    return this.search(this.annotations, embedding, opts);
  }

  private search(points: StoredPoint[], embedding: number[], opts: SearchOptions): VectorSearchResult[] {
    let filtered = points;

    if (opts.filter) {
      const f = opts.filter;
      filtered = points.filter(p => {
        if (f.resourceId && p.payload.resourceId !== String(f.resourceId)) return false;
        if (f.excludeResourceId && p.payload.resourceId === String(f.excludeResourceId)) return false;
        if (f.motivation && p.payload.motivation !== f.motivation) return false;
        if (f.entityTypes && f.entityTypes.length > 0) {
          const pTypes = p.payload.entityTypes ?? [];
          if (!f.entityTypes.some(t => pTypes.includes(t))) return false;
        }
        return true;
      });
    }

    const scored = filtered.map(p => ({
      ...p,
      score: cosineSimilarity(embedding, p.vector),
    }));

    scored.sort((a, b) => b.score - a.score);

    if (opts.scoreThreshold) {
      const threshold = opts.scoreThreshold;
      return scored
        .filter(s => s.score >= threshold)
        .slice(0, opts.limit)
        .map(s => this.toResult(s));
    }

    return scored.slice(0, opts.limit).map(s => this.toResult(s));
  }

  private toResult(s: StoredPoint & { score: number }): VectorSearchResult {
    return {
      id: s.id,
      score: s.score,
      resourceId: s.payload.resourceId as ResourceId,
      annotationId: s.payload.annotationId as AnnotationId | undefined,
      text: s.payload.text,
      entityTypes: s.payload.entityTypes,
    };
  }
}
