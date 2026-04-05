/**
 * EmbeddingProvider Factory
 */

import type { EmbeddingProvider } from './interface';

export interface EmbeddingConfig {
  type: 'voyage' | 'ollama';
  model: string;
  apiKey?: string;
  baseURL?: string;
  endpoint?: string;
}

export async function createEmbeddingProvider(config: EmbeddingConfig): Promise<EmbeddingProvider> {
  if (config.type === 'voyage') {
    const { VoyageEmbeddingProvider } = await import('./voyage');
    if (!config.apiKey) throw new Error('apiKey is required for Voyage embedding provider');
    return new VoyageEmbeddingProvider({
      apiKey: config.apiKey,
      model: config.model,
      endpoint: config.endpoint,
    });
  }

  if (config.type === 'ollama') {
    const { OllamaEmbeddingProvider } = await import('./ollama');
    return new OllamaEmbeddingProvider({
      model: config.model,
      baseURL: config.baseURL,
    });
  }

  throw new Error(`Unknown embedding provider type: ${config.type}`);
}
