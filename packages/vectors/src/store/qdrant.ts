/**
 * Qdrant VectorStore Implementation
 *
 * Uses the Qdrant REST API via @qdrant/js-client-rest.
 * Manages two collections: 'resources' and 'annotations'.
 */

import { createHash } from 'crypto';
import type { QdrantClient, Schemas } from '@qdrant/js-client-rest';
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
  private client: QdrantClient | null = null;
  private config: QdrantConfig;

  constructor(config: QdrantConfig) {
    this.config = config;
  }

  private get qdrant(): QdrantClient {
    if (!this.client) throw new Error('QdrantVectorStore is not connected');
    return this.client;
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
    // Index the discriminator so excludeEntityTypes filtering scales.
    await this.ensurePayloadIndex('resources', 'entityTypes');
  }

  async disconnect(): Promise<void> {
    this.client = null;
  }

  async clearAll(): Promise<void> {
    try { await this.qdrant.deleteCollection('resources'); } catch { /* may not exist */ }
    try { await this.qdrant.deleteCollection('annotations'); } catch { /* may not exist */ }
    await this.ensureCollection('resources', this.config.dimensions);
    await this.ensureCollection('annotations', this.config.dimensions);
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  private async ensureCollection(name: string, dimensions: number): Promise<void> {
    try {
      await this.qdrant.getCollection(name);
    } catch {
      await this.qdrant.createCollection(name, {
        vectors: { size: dimensions, distance: 'Cosine' },
      });
    }
  }

  /**
   * Idempotently create a keyword payload index. Qdrant accepts a repeat call
   * for an already-indexed field, so this runs safely on every connect and
   * back-fills the index on collections created before the field was indexed.
   */
  private async ensurePayloadIndex(collection: string, field: string): Promise<void> {
    try {
      await this.qdrant.createPayloadIndex(collection, { field_name: field, field_schema: 'keyword' });
    } catch { /* already indexed, or created concurrently */ }
  }

  async upsertResourceVectors(resourceId: ResourceId, chunks: EmbeddingChunk[], contentChecksum: string, entityTypes: string[]): Promise<void> {
    // Replace semantics: purge existing chunks first, or a resource that
    // shrinks leaves orphan points at the higher chunk indices.
    await this.deleteResourceVectors(resourceId);
    if (chunks.length === 0) return;

    const points = chunks.map((chunk) => ({
      id: toQdrantId(`${resourceId}-${chunk.chunkIndex}`),
      vector: chunk.embedding,
      payload: {
        resourceId: String(resourceId),
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        contentChecksum,
        entityTypes,
      },
    }));

    await this.qdrant.upsert('resources', { points });
  }

  async upsertAnnotationVector(
    annotationId: AnnotationId,
    embedding: number[],
    payload: AnnotationPayload
  ): Promise<void> {
    await this.qdrant.upsert('annotations', {
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
    await this.qdrant.delete('resources', {
      filter: {
        must: [{ key: 'resourceId', match: { value: String(resourceId) } }],
      },
    });
  }

  async deleteAnnotationVector(annotationId: AnnotationId): Promise<void> {
    await this.qdrant.delete('annotations', {
      points: [toQdrantId(String(annotationId))],
    });
  }

  async deleteAnnotationVectorsForResource(resourceId: ResourceId): Promise<void> {
    await this.qdrant.delete('annotations', {
      filter: {
        must: [{ key: 'resourceId', match: { value: String(resourceId) } }],
      },
    });
  }

  async count(): Promise<number> {
    const [resources, annotations] = await Promise.all([
      this.qdrant.count('resources', { exact: true }),
      this.qdrant.count('annotations', { exact: true }),
    ]);
    return resources.count + annotations.count;
  }

  async listResourceChecksums(): Promise<Map<string, string | undefined>> {
    const checksums = new Map<string, string | undefined>();
    let offset: Schemas['ScrollRequest']['offset'] = undefined;
    do {
      const page = await this.qdrant.scroll('resources', {
        limit: 1000,
        offset,
        with_payload: ['resourceId', 'contentChecksum'],
        with_vector: false,
      });
      for (const point of page.points) {
        const rid = point.payload?.resourceId;
        if (typeof rid !== 'string' || checksums.has(rid)) continue;
        const checksum = point.payload?.contentChecksum;
        checksums.set(rid, typeof checksum === 'string' ? checksum : undefined);
      }
      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    return checksums;
  }

  async listAnnotationIds(): Promise<Set<string>> {
    return this.scrollPayloadField('annotations', 'annotationId');
  }

  /** Collect the distinct values of one payload field across a collection. */
  private async scrollPayloadField(collection: string, field: string): Promise<Set<string>> {
    const values = new Set<string>();
    let offset: Schemas['ScrollRequest']['offset'] = undefined;
    do {
      const page = await this.qdrant.scroll(collection, {
        limit: 1000,
        offset,
        with_payload: [field],
        with_vector: false,
      });
      for (const point of page.points) {
        const value = point.payload?.[field];
        if (typeof value === 'string') values.add(value);
      }
      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    return values;
  }

  async searchResources(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    return this.search('resources', embedding, opts);
  }

  async searchAnnotations(embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    return this.search('annotations', embedding, opts);
  }

  async searchByResource(resourceId: ResourceId, opts: SearchOptions): Promise<VectorSearchResult[]> {
    // Fetch the resource's stored chunk vectors (page through all of them so a
    // long resource isn't silently truncated).
    const queryVectors: number[][] = [];
    let offset: Schemas['ScrollRequest']['offset'] = undefined;
    do {
      const page = await this.qdrant.scroll('resources', {
        filter: { must: [{ key: 'resourceId', match: { value: String(resourceId) } }] },
        with_vector: true,
        with_payload: false,
        limit: 256,
        offset,
      });
      for (const point of page.points) {
        if (Array.isArray(point.vector)) queryVectors.push(point.vector as number[]);
      }
      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);

    if (queryVectors.length === 0) return [];

    // Self-exclude the source; carry the caller's filter (e.g. excludeEntityTypes).
    const filter = this.buildFilter({ ...opts.filter, excludeResourceId: resourceId });

    // One batched search per query chunk (single round-trip), top-`limit` each;
    // over-fetch beyond `limit` is unnecessary because the max-sim merge only
    // needs a target in some chunk's top-K to surface.
    const searches = queryVectors.map((vector) => ({
      vector,
      limit: opts.limit,
      score_threshold: opts.scoreThreshold,
      filter: filter ?? undefined,
      with_payload: true,
    }));
    const batches = await this.qdrant.searchBatch('resources', { searches });

    // Max-sim merge: dedup by resourceId, keep the best (query-chunk × target-chunk)
    // score and the best-matching target chunk's payload.
    const bestByResource = new Map<string, { id: string; score: number; payload: Record<string, unknown> }>();
    for (const batch of batches) {
      for (const r of batch) {
        const payload = r.payload ?? {};
        const tid = String(payload.resourceId);
        const prev = bestByResource.get(tid);
        if (!prev || r.score > prev.score) {
          bestByResource.set(tid, { id: String(r.id), score: r.score, payload });
        }
      }
    }

    return [...bestByResource.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit)
      .map((m) => ({
        id: m.id,
        score: m.score,
        resourceId: m.payload.resourceId as ResourceId,
        annotationId: m.payload.annotationId as AnnotationId | undefined,
        text: m.payload.text as string,
        entityTypes: m.payload.entityTypes as string[] | undefined,
      }));
  }

  private async search(collection: string, embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    const filter = this.buildFilter(opts.filter);

    const results = await this.qdrant.search(collection, {
      vector: embedding,
      limit: opts.limit,
      score_threshold: opts.scoreThreshold,
      filter: filter ?? undefined,
      with_payload: true,
    });

    return results.map((r) => {
      const payload = r.payload ?? {};
      return {
        id: String(r.id),
        score: r.score,
        resourceId: payload.resourceId as ResourceId,
        annotationId: payload.annotationId as AnnotationId | undefined,
        text: payload.text as string,
        entityTypes: payload.entityTypes as string[] | undefined,
      };
    });
  }

  private buildFilter(filter?: SearchOptions['filter']): Schemas['Filter'] | null {
    if (!filter) return null;

    const must: Schemas['FieldCondition'][] = [];

    if (filter.entityTypes && filter.entityTypes.length > 0) {
      // any-of: match payloads whose `entityTypes` array contains at least one
      // of the requested types. Matches the memory store's `some(t => ...)`
      // semantics; pushing one `must` clause per type would mean all-of.
      must.push({ key: 'entityTypes', match: { any: filter.entityTypes } });
    }

    if (filter.resourceId) {
      must.push({ key: 'resourceId', match: { value: String(filter.resourceId) } });
    }

    if (filter.motivation) {
      must.push({ key: 'motivation', match: { value: filter.motivation } });
    }

    const must_not: Schemas['FieldCondition'][] = [];

    if (filter.excludeResourceId) {
      must_not.push({ key: 'resourceId', match: { value: String(filter.excludeResourceId) } });
    }

    if (filter.excludeEntityTypes && filter.excludeEntityTypes.length > 0) {
      // any-of exclusion: drop points whose entityTypes contain any of these.
      must_not.push({ key: 'entityTypes', match: { any: filter.excludeEntityTypes } });
    }

    if (must.length === 0 && must_not.length === 0) return null;

    return {
      ...(must.length > 0 ? { must } : {}),
      ...(must_not.length > 0 ? { must_not } : {}),
    };
  }
}
