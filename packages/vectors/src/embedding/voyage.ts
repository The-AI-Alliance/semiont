/**
 * Voyage AI Embedding Provider
 *
 * Cloud embedding via the Voyage AI API.
 * Requires a Voyage AI API key (distinct from Anthropic inference keys).
 */

import { boundedGate } from '@semiont/core';
import type { EmbeddingProvider } from './interface';
import { EmbeddingProviderError, EMBED_ROUND_TRIP_TIMEOUT_MS } from './provider-error';

/**
 * How many requests to this provider may be in flight at once, per process.
 *
 * Same treatment as Ollama's, different constraints — which is exactly why the
 * number is per provider rather than one shared: a local single-model process
 * and a rate-limited cloud API have no honest common value.
 *
 * A STATED GUESS, accepted as such, because nothing in this repo records
 * Voyage's published limits: modest overlap, because a network-latency-bound
 * API gains real throughput from it where a local model does not. Invalidated
 * by the account's documented rate limit.
 */
export const VOYAGE_CONCURRENCY = 4;

export interface VoyageConfig {
  apiKey: string;
  model: string;
  endpoint?: string;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private config: VoyageConfig;
  private dimensionsPromise?: Promise<number>;
  /** Built once per provider — see `OllamaEmbeddingProvider`'s gate note; the
   *  cap spans every caller of this instance and bounds this process only. */
  private gate = boundedGate(VOYAGE_CONCURRENCY);

  constructor(config: VoyageConfig) {
    this.config = config;
  }

  async embed(text: string): Promise<number[]> {
    return this.gate(async () => {
      const endpoint = this.config.endpoint ?? 'https://api.voyageai.com/v1/embeddings';

      // The deadline is created HERE — inside the gated thunk — so a queued
      // request still gets a whole budget.
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        signal: AbortSignal.timeout(EMBED_ROUND_TRIP_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.config.model,
          input: [text],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new EmbeddingProviderError('voyage', response.status, this.config.model, body);
      }

      const json = await response.json() as { data: Array<{ embedding: number[] }> };
      const [embedding] = json.data.map(d => d.embedding);
      return embedding;
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
      throw new Error(`Voyage returned no embedding for dimension probe of model '${this.config.model}'`);
    }
    return probe.length;
  }
}
