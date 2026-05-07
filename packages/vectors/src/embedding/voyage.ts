/**
 * Voyage AI Embedding Provider
 *
 * Cloud embedding via the Voyage AI API (partner of Anthropic).
 * Uses the same API key as Anthropic inference.
 */

import type { EmbeddingProvider } from './interface';

export interface VoyageConfig {
  apiKey: string;
  model: string;
  endpoint?: string;
}

const VOYAGE_DIMENSIONS: Record<string, number> = {
  'voyage-3': 1024,
  'voyage-3-lite': 512,
  'voyage-code-3': 1024,
  'voyage-finance-2': 1024,
  'voyage-law-2': 1024,
};

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private config: VoyageConfig;

  constructor(config: VoyageConfig) {
    this.config = config;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const endpoint = this.config.endpoint ?? 'https://api.voyageai.com/v1/embeddings';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage API error ${response.status}: ${body}`);
    }

    const json = await response.json() as { data: Array<{ embedding: number[] }> };
    return json.data.map(d => d.embedding);
  }

  dimensions(): number {
    return VOYAGE_DIMENSIONS[this.config.model] ?? 1024;
  }

  model(): string {
    return this.config.model;
  }
}
