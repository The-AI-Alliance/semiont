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
  dimensions: number;
}

export async function createVectorStore(config: VectorStoreConfig): Promise<VectorStore> {
  let store: VectorStore;

  if (config.type === 'qdrant') {
    const { QdrantVectorStore } = await import('./qdrant');
    store = new QdrantVectorStore({
      host: config.host ?? 'localhost',
      port: config.port ?? 6333,
      dimensions: config.dimensions,
    });
  } else {
    store = new MemoryVectorStore();
  }

  await store.connect();
  return store;
}
