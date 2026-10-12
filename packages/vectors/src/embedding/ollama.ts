/**
 * Ollama Embedding Provider
 *
 * Local embedding via the Ollama API.
 * Uses models like nomic-embed-text, all-minilm, etc.
 */

import { boundedGate } from '@semiont/core';
import type { EmbeddingProvider } from './interface';
import { EmbeddingProviderError, EMBED_ROUND_TRIP_TIMEOUT_MS } from './provider-error';

/**
 * How many requests to this provider may be in flight at once, per process.
 *
 * Ollama publishes no rate limit to derive one from, so this is an owned
 * constant with its provenance stated: one local process serving one model.
 * Concurrent requests mostly queue, and can thrash memory while a model is
 * resident. Sequential is not a limitation here, it is the honest shape of the
 * resource. Invalidated by a multi-replica or GPU-partitioned deployment.
 */
export const OLLAMA_CONCURRENCY = 1;

export interface OllamaEmbeddingConfig {
  model: string;
  baseURL?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private config: OllamaEmbeddingConfig;
  private dimensionsPromise?: Promise<number>;
  /**
   * Built once per provider, so the cap spans every caller of this instance. A
   * gate created per call would be multiplied by the number of concurrent
   * callers, which is not a cap.
   *
   * Bounds this PROCESS. Each process pointed at one Ollama holds a cap of its
   * own, so the effective ceiling is the sum; that is inherent without
   * distributed coordination and is not what this constant claims.
   */
  private gate = boundedGate(OLLAMA_CONCURRENCY);

  constructor(config: OllamaEmbeddingConfig) {
    this.config = config;
  }

  async embed(text: string): Promise<number[]> {
    // The ONE gated round trip in this provider. `measureDimensions` probes
    // through here, which gates the probe too.
    return this.gate(async () => {
      const baseURL = this.config.baseURL ?? 'http://localhost:11434';

      // The deadline is created HERE — inside the gated thunk — so a request
      // that queued behind others still gets a whole budget rather than
      // inheriting one that was ticking while it waited.
      const response = await fetch(`${baseURL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(EMBED_ROUND_TRIP_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.config.model,
          input: [text],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new EmbeddingProviderError('ollama', response.status, this.config.model, body);
      }

      const json = await response.json() as { embeddings: number[][] };
      return json.embeddings[0];
    });
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
}
