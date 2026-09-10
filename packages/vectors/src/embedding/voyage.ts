/**
 * Voyage AI Embedding Provider
 *
 * Cloud embedding via the Voyage AI API.
 * Requires a Voyage AI API key (distinct from Anthropic inference keys).
 */

import { boundedGate, type BatchPolicy } from '@semiont/core';
import type { EmbeddingProvider } from './interface';
import { EmbeddingProviderError, EMBED_ROUND_TRIP_TIMEOUT_MS } from './provider-error';
import { slicedEmbed } from './sliced-batch';

/**
 * How this provider batches, and how much of it may be in flight at once.
 *
 * Same treatment as Ollama's, different constraints — which is exactly why the
 * policy is per provider rather than one shared number: a local single-model
 * process and a rate-limited cloud API with a request-size ceiling have no
 * honest common value.
 *
 * Both values are STATED GUESSES, accepted as such (user, 2026-09-10), because
 * nothing in this repo records Voyage's published limits:
 *
 * `sliceSize: 128` — carried over from the measured Ollama anchor (~73 texts/s
 *   => ~1.75 s per round trip) for want of a Voyage measurement. Voyage is the
 *   provider that also has a REQUEST-SIZE ceiling, so this is the value most
 *   likely to need correcting. Invalidated by Voyage's published per-request
 *   maximum, if it is lower.
 *
 * `concurrency: 4` — modest overlap, because a network-latency-bound API gains
 *   real throughput from it where a local model does not. Invalidated by the
 *   account's documented rate limit.
 */
export const VOYAGE_BATCH_POLICY: BatchPolicy = { sliceSize: 128, concurrency: 4 };

export interface VoyageConfig {
  apiKey: string;
  model: string;
  endpoint?: string;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private config: VoyageConfig;
  private dimensionsPromise?: Promise<number>;
  /** Built once per provider — see `OLLAMA_BATCH_POLICY`'s gate note; the cap
   *  spans every caller of this instance and bounds this process only. */
  private gate = boundedGate(VOYAGE_BATCH_POLICY.concurrency);

  constructor(config: VoyageConfig) {
    this.config = config;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return slicedEmbed({
      texts,
      policy: VOYAGE_BATCH_POLICY,
      provider: 'voyage',
      model: this.config.model,
      gate: this.gate,
      post: (slice) => this.postSlice(slice),
    });
  }

  private async postSlice(slice: string[]): Promise<number[][]> {
    const endpoint = this.config.endpoint ?? 'https://api.voyageai.com/v1/embeddings';

    // The deadline is created HERE — inside the gated thunk — so a queued slice
    // still gets a whole budget. See `sliced-batch.ts`.
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      signal: AbortSignal.timeout(EMBED_ROUND_TRIP_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.config.model,
        input: slice,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new EmbeddingProviderError('voyage', response.status, this.config.model, body);
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
