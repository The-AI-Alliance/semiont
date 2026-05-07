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

const OLLAMA_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'all-minilm': 384,
  'mxbai-embed-large': 1024,
  'snowflake-arctic-embed': 1024,
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private config: OllamaEmbeddingConfig;

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

  dimensions(): number {
    return OLLAMA_DIMENSIONS[this.config.model] ?? 768;
  }

  model(): string {
    return this.config.model;
  }
}
