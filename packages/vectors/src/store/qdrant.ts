/**
 * Qdrant VectorStore Implementation
 *
 * Uses the Qdrant REST API via @qdrant/js-client-rest.
 * Searches two collections, 'resources' and 'annotations', and makes each
 * where a Qdrant has none.
 */

import type { QdrantClient, Schemas } from '@qdrant/js-client-rest';
import type { ResourceId, AnnotationId } from '@semiont/core';
import type { VectorStore, VectorSearchResult, SearchOptions } from './interface';
import { mergeByResource } from './merge';
import { resolveDimensions } from '../embedding/resolve-dimensions';

/**
 * Map a scored point to the store-agnostic result shape. Shared by every read
 * path so the payload→result contract (including `machineRead`) has one home.
 */
function toSearchResult(point: Schemas['ScoredPoint']): VectorSearchResult {
  const payload = point.payload ?? {};
  return {
    id: String(point.id),
    score: point.score,
    resourceId: payload.resourceId as ResourceId,
    annotationId: payload.annotationId as AnnotationId | undefined,
    text: payload.text as string,
    entityTypes: payload.entityTypes as string[] | undefined,
    ...(payload.machineRead ? { machineRead: true } : {}),
  };
}

export interface QdrantConfig {
  host: string;
  port: number;
  /** Resolves the embedding dimensionality; called only when creating a collection. */
  dimensions: () => Promise<number>;
  /** The caller's boot deadline. Resolving the dimensionality retries while the
   *  provider warms up, and this is what stops it if the caller gives up first. */
  signal?: AbortSignal;
}

export class QdrantVectorStore implements VectorStore {
  /**
   * Per-batch point over-fetch for `searchByResource`. The batch limit caps
   * points while the caller wants resources, so multi-chunk targets would
   * otherwise crowd the top-K. See the call site.
   */
  private static readonly SEARCH_BY_RESOURCE_OVER_FETCH = 4;

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
    await this.ensureCollection('resources');
    await this.ensureCollection('annotations');
    // Payload indexes, as specs/src/vectors/payload-cases.json states them,
    // so a filter on one does not read every point:
    //  - entityTypes: the excludeEntityTypes recall filter.
    //  - resourceId: searchByResource's by-resource scroll + self-exclusion,
    //    and a search that names one resource.
    await this.ensurePayloadIndex('resources', 'entityTypes');
    await this.ensurePayloadIndex('resources', 'resourceId');
    await this.ensurePayloadIndex('annotations', 'resourceId');
  }

  async disconnect(): Promise<void> {
    this.client = null;
  }

  private async ensureCollection(name: string): Promise<void> {
    try {
      await this.qdrant.getCollection(name);
      return;
    } catch { /* absent — create it below, which is the only path needing the size */ }

    // The dimensionality is discovered from the embedding provider, so it is
    // resolved HERE and nowhere else: an existing collection already encodes
    // its vector size, and consulting the provider to re-derive a number we
    // would not use is exactly the eager-probe coupling this avoids.
    //
    // And HERE is also where the retry belongs, not around `connect()`: wrapping
    // connect would re-run `getCollection` and both `ensurePayloadIndex` calls on
    // every attempt — idempotent, but it widens the retry over operations that
    // were not failing. Only this one call needs the provider to be live.
    const size = await resolveDimensions(this.config.dimensions, this.config.signal);
    await this.qdrant.createCollection(name, {
      vectors: { size, distance: 'Cosine' },
    });
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

    // One batched query per source chunk (single round-trip). Each batch's
    // `limit` caps POINTS, but the merge below yields RESOURCES — so a target
    // with many chunks can fill several point-slots and crowd out resources
    // that belong in the top-`limit` after folding. Over-fetch per batch to
    // leave the merge material to work with; the memory store scores every
    // candidate exhaustively, and without this the two gateways disagree on
    // recall. Headroom, not a guarantee: a resource whose chunks are all
    // outranked by OVER_FETCH×limit points in every batch is still missed.
    // Qdrant's group-by would make it exact, but only via the `search`-family
    // endpoints 1.19.0 removed (see qdrant-query-api.test.ts).
    const searches = queryVectors.map((vector) => ({
      query: vector,
      limit: opts.limit * QdrantVectorStore.SEARCH_BY_RESOURCE_OVER_FETCH,
      score_threshold: opts.scoreThreshold,
      filter: filter ?? undefined,
      with_payload: true,
    }));
    const batches = await this.qdrant.queryBatch('resources', { searches });

    // Normalise to VectorSearchResult, then fold chunk hits to one entry per
    // resource (max-sim) via the shared merge; slice to the caller's limit.
    const hits = batches.flatMap((batch) => batch.points.map((r) => toSearchResult(r)));
    return mergeByResource(hits).slice(0, opts.limit);
  }

  private async search(collection: string, embedding: number[], opts: SearchOptions): Promise<VectorSearchResult[]> {
    const filter = this.buildFilter(opts.filter);

    // `query`, not `search`: the REST client dropped `search`/`searchBatch` in
    // 1.19.0 in favour of the universal query endpoint. Same request but the
    // vector moves to `query`, and the response is wrapped in `{ points }`.
    const { points } = await this.qdrant.query(collection, {
      query: embedding,
      limit: opts.limit,
      score_threshold: opts.scoreThreshold,
      filter: filter ?? undefined,
      with_payload: true,
    });

    return points.map((r) => toSearchResult(r));
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
