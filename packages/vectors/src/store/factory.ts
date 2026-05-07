/**
 * VectorStore Factory
 *
 * Creates a VectorStore instance based on configuration.
 */

import type { VectorStore } from './interface';
import { MemoryVectorStore } from './memory';

export interface VectorStoreConfig {
  type: 'qdrant' | 'memory';
  host?: string;
  port?: number;
  dimensions: number;
}

let instance: VectorStore | null = null;

export async function createVectorStore(config: VectorStoreConfig): Promise<VectorStore> {
  if (instance) return instance;

  if (config.type === 'qdrant') {
    const { QdrantVectorStore } = await import('./qdrant');
    instance = new QdrantVectorStore({
      host: config.host ?? 'localhost',
      port: config.port ?? 6333,
      dimensions: config.dimensions,
    });
  } else {
    instance = new MemoryVectorStore();
  }

  await instance.connect();
  return instance;
}

export function getVectorStore(): VectorStore | null {
  return instance;
}
