/**
 * Ollama Embedding Provider
 *
 * Local embedding via the Ollama API.
 * Uses models like nomic-embed-text, all-minilm, etc.
 */

import type { EmbeddingProvider } from './interface';

export interface OllamaEmbeddingConfig {
  model: string;
  baseURL?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private config: OllamaEmbeddingConfig;
  private dimensionsPromise?: Promise<number>;

  constructor(config: OllamaEmbeddingConfig) {
    this.config = config;
  }

  async embed(text: string): Promise<number[]> {
    const baseURL = this.config.baseURL ?? 'http://localhost:11434';

    const response = await fetch(`${baseURL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed error ${response.status}: ${body}`);
    }

    const json = await response.json() as { embeddings: number[][] };
    return json.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama's /api/embed supports batch input
    const baseURL = this.config.baseURL ?? 'http://localhost:11434';

    const response = await fetch(`${baseURL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed error ${response.status}: ${body}`);
    }

    const json = await response.json() as { embeddings: number[][] };
    return json.embeddings;
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
      throw new Error(`Ollama returned no embedding for dimension probe of model '${this.config.model}'`);
    }
    return probe.length;
  }

  model(): string {
    return this.config.model;
  }
}
