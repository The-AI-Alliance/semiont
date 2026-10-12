/**
 * A vector index held in memory, for a test of something that searches the
 * index.
 *
 * It is given the points it holds when it is made, and nothing writes to it
 * after: the one writer of the index is the Smelter, and the Smelter is not
 * in this package. A point is held as the index holds one, its vector and
 * its payload (specs/src/vectors/payload-cases.json states a payload), so
 * what a search answers from here is read from what a Qdrant would hold.
 *
 * Brute-force cosine similarity.
 */

import type { ResourceId, AnnotationId } from '@semiont/core';
import type { VectorStore, VectorSearchResult, SearchOptions } from './interface';
import { mergeByResource } from './merge';

/** A point of the index: its id, its vector, and its payload. */
export interface MemoryPoint {
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
    machineRead?: boolean;
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
  private readonly resources: MemoryPoint[];
  private readonly annotations: MemoryPoint[];

  /** `resources` are the points of the resources collection, `annotations` those of the annotations collection. */
  constructor(held: { resources: MemoryPoint[]; annotations: MemoryPoint[] }) {
    this.resources = [...held.resources];
    this.annotations = [...held.annotations];
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

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

    // Score every candidate point against the source's chunks (exhaustive — no
    // per-chunk top-K to crowd anything out), then let the shared max-sim fold
    // collapse chunk hits to one entry per resource.
    const hits: VectorSearchResult[] = [];
    for (const cand of this.resources) {
      if (!this.passesFilter(cand, filter)) continue;
      let best = -Infinity;
      for (const q of queryPoints) {
        const score = cosineSimilarity(q.vector, cand.vector);
        if (score > best) best = score;
      }
      if (opts.scoreThreshold !== undefined && best < opts.scoreThreshold) continue;
      hits.push(this.toResult({ ...cand, score: best }));
    }

    return mergeByResource(hits).slice(0, opts.limit);
  }

  private passesFilter(p: MemoryPoint, filter: SearchOptions['filter']): boolean {
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

  private search(points: MemoryPoint[], embedding: number[], opts: SearchOptions): VectorSearchResult[] {
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

  private toResult(s: MemoryPoint & { score: number }): VectorSearchResult {
    return {
      id: s.id,
      score: s.score,
      resourceId: s.payload.resourceId as ResourceId,
      annotationId: s.payload.annotationId as AnnotationId | undefined,
      text: s.payload.text,
      entityTypes: s.payload.entityTypes,
      ...(s.payload.machineRead ? { machineRead: true } : {}),
    };
  }
}
