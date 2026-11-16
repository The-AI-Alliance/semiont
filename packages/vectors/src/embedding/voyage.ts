/**
 * Voyage AI Embedding Provider
 *
 * Cloud embedding via the Voyage AI API.
 * Requires a Voyage AI API key (distinct from Anthropic inference keys).
 */

import type { EmbeddingProvider } from './interface';

export interface VoyageConfig {
  apiKey: string;
  model: string;
  endpoint?: string;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private config: VoyageConfig;
  private dimensionsPromise?: Promise<number>;

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

  dimensions(): Promise<number> {
    if (!this.dimensionsPromise) {
      this.dimensionsPromise = this.measureDimensions().catch((err: unknown) => {
        // Never cache a failed discovery — a transient outage would otherwise
        // pin every future call to the same rejection.
        this.dimensionsPromise = undefined;
        throw err;
      });
    }
    return this.dimensionsPromise;
  }

  private async measureDimensions(): Promise<number> {
    // Dimensionality is intrinsic to the model, so the model is the
    // authority: embed a probe and measure it. A hand-maintained table goes
    // stale the day a new model ships and silently mis-sizes the index.
    const probe = await this.embed('dimension probe');
    if (!Array.isArray(probe) || probe.length === 0) {
      throw new Error(`Voyage returned no embedding for dimension probe of model '${this.config.model}'`);
    }
    return probe.length;
  }

  model(): string {
    return this.config.model;
  }
}
