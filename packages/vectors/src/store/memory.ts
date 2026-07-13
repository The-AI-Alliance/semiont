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
    contentChecksum?: string;
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

  async clearAll(): Promise<void> {
    this.resources = [];
    this.annotations = [];
  }

  isConnected(): boolean {
    return this.connected;
  }

  async upsertResourceVectors(resourceId: ResourceId, chunks: EmbeddingChunk[], contentChecksum: string, entityTypes: string[]): Promise<void> {
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
          contentChecksum,
          entityTypes,
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

  async deleteAnnotationVectorsForResource(resourceId: ResourceId): Promise<void> {
    this.annotations = this.annotations.filter(p => p.payload.resourceId !== String(resourceId));
  }

  async count(): Promise<number> {
    return this.resources.length + this.annotations.length;
  }

  async updateResourceEntityTypes(resourceId: ResourceId, entityTypes: string[]): Promise<void> {
    for (const p of this.resources) {
      if (p.payload.resourceId === String(resourceId)) {
        p.payload.entityTypes = entityTypes;
      }
    }
  }

  async listResourceStamps(): Promise<Map<string, { contentChecksum: string | undefined; entityTypes: string[] }>> {
    const stamps = new Map<string, { contentChecksum: string | undefined; entityTypes: string[] }>();
    for (const p of this.resources) {
      if (!stamps.has(p.payload.resourceId)) {
        stamps.set(p.payload.resourceId, {
          contentChecksum: p.payload.contentChecksum,
          entityTypes: p.payload.entityTypes ?? [],
        });
      }
    }
    return stamps;
  }

  async listAnnotationIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const p of this.annotations) {
      if (p.payload.annotationId) ids.add(p.payload.annotationId);
    }
    return ids;
  }

  async searchResources(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    return this.search(this.resources, embedding, opts);
  }

  async searchAnnotations(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    return this.search(this.annotations, embedding, opts);
  }

  async searchByResource(resourceId: ResourceId, opts: SearchOptions): Promise<VectorSearchResult[]> {
    const rid = String(resourceId);
    const queryPoints = this.resources.filter(p => p.payload.resourceId === rid);
    if (queryPoints.length === 0) return [];

    // Self-exclude the source; carry the caller's filter (e.g. excludeEntityTypes).
    const filter: SearchOptions['filter'] = { ...opts.filter, excludeResourceId: resourceId };

    // Per-chunk max-sim, merged by resource: each candidate point scores as the
    // best similarity to any of the source's query chunks; keep, per target
    // resource, the single best-matching point (its score and its text).
    const bestByResource = new Map<string, StoredPoint & { score: number }>();
    for (const cand of this.resources) {
      if (!this.passesFilter(cand, filter)) continue;
      let best = -Infinity;
      for (const q of queryPoints) {
        const score = cosineSimilarity(q.vector, cand.vector);
        if (score > best) best = score;
      }
      const prev = bestByResource.get(cand.payload.resourceId);
      if (!prev || best > prev.score) {
        bestByResource.set(cand.payload.resourceId, { ...cand, score: best });
      }
    }

    let merged = [...bestByResource.values()];
    if (opts.scoreThreshold !== undefined) {
      const threshold = opts.scoreThreshold;
      merged = merged.filter(s => s.score >= threshold);
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, opts.limit).map(s => this.toResult(s));
  }

  private passesFilter(p: StoredPoint, filter: SearchOptions['filter']): boolean {
    if (!filter) return true;
    const f = filter;
    if (f.resourceId && p.payload.resourceId !== String(f.resourceId)) return false;
    if (f.excludeResourceId && p.payload.resourceId === String(f.excludeResourceId)) return false;
    if (f.motivation && p.payload.motivation !== f.motivation) return false;
    if (f.entityTypes && f.entityTypes.length > 0) {
      const pTypes = p.payload.entityTypes ?? [];
      if (!f.entityTypes.some(t => pTypes.includes(t))) return false;
    }
    if (f.excludeEntityTypes && f.excludeEntityTypes.length > 0) {
      const pTypes = p.payload.entityTypes ?? [];
      if (f.excludeEntityTypes.some(t => pTypes.includes(t))) return false;
    }
    return true;
  }

  private search(points: StoredPoint[], embedding: number[], opts: SearchOptions): VectorSearchResult[] {
    const filtered = points.filter(p => this.passesFilter(p, opts.filter));

    const scored = filtered.map(p => ({
      ...p,
      score: cosineSimilarity(embedding, p.vector),
    }));

    scored.sort((a, b) => b.score - a.score);

    if (opts.scoreThreshold !== undefined) {
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
