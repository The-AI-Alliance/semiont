/**
 * VectorStore Factory
 *
 * Creates a connected VectorStore instance based on configuration.
 */

import type { VectorStore } from './interface';

export interface VectorStoreConfig {
  type: 'qdrant' | 'memory';
  host?: string;
  port?: number;
  /**
   * Resolves the embedding dimensionality — a *thunk*, not a value, so the
   * provider is consulted only when the number is needed. Mirrors how
   * inference treats provider-derived facts: the client is constructed with
   * zero I/O and its `limits()` are discovered at the point of use, never
   * eagerly at startup.
   *
   * Qdrant calls it only when it has to *create* a collection, so an
   * already-provisioned instance connects without touching the embedding
   * provider at all.
   */
  dimensions: () => Promise<number>;
  /** The caller's boot deadline, passed to whatever retries while warming up. */
  signal?: AbortSignal;
}

export async function createVectorStore(config: VectorStoreConfig): Promise<VectorStore> {
  // `memory` is an index a test makes, with the points it holds
  // (MemoryVectorStore). No configuration yields one: it could not be shared
  // with the Smelter that writes the index, and the Librarian refuses it.
  if (config.type !== 'qdrant') {
    throw new Error(`Unsupported vector store type: ${config.type}`);
  }

  const { QdrantVectorStore } = await import('./qdrant');
  const store = new QdrantVectorStore({
    host: config.host ?? 'localhost',
    port: config.port ?? 6333,
    dimensions: config.dimensions,
    ...(config.signal ? { signal: config.signal } : {}),
  });

  await store.connect();
  return store;
}
