/**
 * Qdrant VectorStore Implementation
 *
 * Uses the Qdrant REST API via @qdrant/js-client-rest.
 * Manages two collections: 'resources' and 'annotations'.
 */

import { createHash } from 'crypto';
import type { ResourceId, AnnotationId } from '@semiont/core';
import type { VectorStore, EmbeddingChunk, AnnotationPayload, VectorSearchResult, SearchOptions } from './interface';

/**
 * Generate a deterministic UUID v5-style ID from an arbitrary string.
 * Qdrant requires point IDs to be UUIDs or unsigned integers.
 */
function toQdrantId(input: string): string {
  const hex = createHash('md5').update(input).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface QdrantConfig {
  host: string;
  port: number;
  dimensions: number;
}

export class QdrantVectorStore implements VectorStore {
  private client: any = null;
  private connected = false;
  private config: QdrantConfig;

  constructor(config: QdrantConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    this.client = new QdrantClient({
      host: this.config.host,
      port: this.config.port,
    });

    // Ensure collections exist
    await this.ensureCollection('resources', this.config.dimensions);
    await this.ensureCollection('annotations', this.config.dimensions);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async ensureCollection(name: string, dimensions: number): Promise<void> {
    try {
      await this.client.getCollection(name);
    } catch {
      await this.client.createCollection(name, {
        vectors: { size: dimensions, distance: 'Cosine' },
      });
    }
  }

  async upsertResourceVectors(resourceId: ResourceId, chunks: EmbeddingChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const points = chunks.map((chunk) => ({
      id: toQdrantId(`${resourceId}-${chunk.chunkIndex}`),
      vector: chunk.embedding,
      payload: {
        resourceId: String(resourceId),
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
      },
    }));

    await this.client.upsert('resources', { points });
  }

  async upsertAnnotationVector(
    annotationId: AnnotationId,
    embedding: number[],
    payload: AnnotationPayload
  ): Promise<void> {
    await this.client.upsert('annotations', {
      points: [{
        id: toQdrantId(String(annotationId)),
        vector: embedding,
        payload: {
          annotationId: String(payload.annotationId),
          resourceId: String(payload.resourceId),
          motivation: payload.motivation,
          entityTypes: payload.entityTypes,
          text: payload.exactText,
        },
      }],
    });
  }

  async deleteResourceVectors(resourceId: ResourceId): Promise<void> {
    await this.client.delete('resources', {
      filter: {
        must: [{ key: 'resourceId', match: { value: String(resourceId) } }],
      },
    });
  }

  async deleteAnnotationVector(annotationId: AnnotationId): Promise<void> {
    await this.client.delete('annotations', {
      points: [toQdrantId(String(annotationId))],
    });
  }

  async searchResources(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    return this.search('resources', embedding, opts);
  }

  async searchAnnotations(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    return this.search('annotations', embedding, opts);
  }

  private async search(collection: string, embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    const filter = this.buildFilter(opts.filter);

    const results = await this.client.search(collection, {
      vector: embedding,
      limit: opts.limit,
      score_threshold: opts.scoreThreshold,
      filter: filter || undefined,
      with_payload: true,
    });

    return results.map((r: any) => ({
      id: String(r.id),
      score: r.score,
      resourceId: r.payload.resourceId as ResourceId,
      annotationId: r.payload.annotationId as AnnotationId | undefined,
      text: r.payload.text as string,
      entityTypes: r.payload.entityTypes as string[] | undefined,
    }));
  }

  private buildFilter(filter?: SearchOptions['filter']): any | null {
    if (!filter) return null;

    const must: any[] = [];

    if (filter.entityTypes && filter.entityTypes.length > 0) {
      for (const et of filter.entityTypes) {
        must.push({ key: 'entityTypes', match: { value: et } });
      }
    }

    if (filter.resourceId) {
      must.push({ key: 'resourceId', match: { value: String(filter.resourceId) } });
    }

    if (filter.motivation) {
      must.push({ key: 'motivation', match: { value: filter.motivation } });
    }

    const must_not: any[] = [];

    if (filter.excludeResourceId) {
      must_not.push({ key: 'resourceId', match: { value: String(filter.excludeResourceId) } });
    }

    if (must.length === 0 && must_not.length === 0) return null;

    return {
      ...(must.length > 0 ? { must } : {}),
      ...(must_not.length > 0 ? { must_not } : {}),
    };
  }
}
