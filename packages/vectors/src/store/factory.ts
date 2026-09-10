/**
 * VectorStore Factory
 *
 * Creates a connected VectorStore instance based on configuration.
 */

import type { VectorStore } from './interface';
import { MemoryVectorStore } from './memory';

export interface VectorStoreConfig {
  type: 'qdrant' | 'memory';
  host?: string;
  port?: number;
  /**
   * Resolves the embedding dimensionality — a *thunk*, not a value, so the
   * provider is consulted only by a store that actually needs the number and
   * only when it needs it. Mirrors how inference treats provider-derived
   * facts: the client is constructed with zero I/O and its `limits()` are
   * discovered at the point of use, never eagerly at startup.
   *
   * `MemoryVectorStore` never calls it. Qdrant calls it only when it has to
   * *create* a collection, so an already-provisioned instance connects
   * without touching the embedding provider at all.
   */
  dimensions: () => Promise<number>;
  /** The caller's boot deadline, passed to whatever retries while warming up. */
  signal?: AbortSignal;
}

export async function createVectorStore(config: VectorStoreConfig): Promise<VectorStore> {
  let store: VectorStore;

  if (config.type === 'qdrant') {
    const { QdrantVectorStore } = await import('./qdrant');
    store = new QdrantVectorStore({
      host: config.host ?? 'localhost',
      port: config.port ?? 6333,
      dimensions: config.dimensions,
      ...(config.signal ? { signal: config.signal } : {}),
    });
  } else {
    // MemoryVectorStore holds whatever vectors it is handed — it never reads a
    // configured dimensionality, so the thunk is deliberately never called and
    // a memory-backed deployment boots without contacting the provider.
    store = new MemoryVectorStore();
  }

  await store.connect();
  return store;
}
