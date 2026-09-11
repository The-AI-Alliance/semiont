/**
 * Ollama Embedding Provider
 *
 * Local embedding via the Ollama API.
 * Uses models like nomic-embed-text, all-minilm, etc.
 */

import { boundedGate, type BatchPolicy } from '@semiont/core';
import type { EmbeddingProvider } from './interface';
import { EmbeddingProviderError, EMBED_ROUND_TRIP_TIMEOUT_MS } from './provider-error';
import { slicedEmbed } from './sliced-batch';

/**
 * How this provider batches, and how much of it may be in flight at once.
 *
 * The house rule derives budgets from `limits()` rather than hand-tuning them
 * (detection chunking, #1121). Ollama publishes no batch ceiling and no rate
 * limit to derive from, so these are owned constants with their provenance
 * stated — the treatment DETECTION-QUALITY-THROUGHPUT P2 gave its duration
 * setpoint.
 *
 * `sliceSize: 128` — measured: ~1,100 chunks took ~15 s on a host-local
 *   `nomic-embed-text` (~73/s), so 128 is ~1.75 s per round trip, roughly 8x
 *   inside the deadline. Invalidated by a materially faster or slower model.
 *
 * `concurrency: 1` — one local process serving one model: concurrent requests
 *   mostly queue, and can thrash memory while a model is resident. Sequential is
 *   not a limitation here, it is the honest shape of the resource. Invalidated
 *   by a multi-replica or GPU-partitioned deployment.
 */
export const OLLAMA_BATCH_POLICY: BatchPolicy = { sliceSize: 128, concurrency: 1 };

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
   * callers — the smelter runs a reconcile wave of 8 — which is not a cap.
   *
   * Bounds this PROCESS. A backend and a smelter pointed at one Ollama hold one
   * of these each, so the effective ceiling is the sum; that is inherent without
   * distributed coordination and is not what this constant claims.
   */
  private gate = boundedGate(OLLAMA_BATCH_POLICY.concurrency);

  constructor(config: OllamaEmbeddingConfig) {
    this.config = config;
  }

  async embed(text: string): Promise<number[]> {
    // Through the same path as a batch, so there is ONE gated round trip in this
    // provider rather than two that must be kept in agreement.
    // `measureDimensions` probes through here, which gates the probe too.
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return slicedEmbed({
      texts,
      policy: OLLAMA_BATCH_POLICY,
      provider: 'ollama',
      model: this.config.model,
      gate: this.gate,
      post: (slice) => this.postSlice(slice),
    });
  }

  private async postSlice(slice: string[]): Promise<number[][]> {
    const baseURL = this.config.baseURL ?? 'http://localhost:11434';

    // The deadline is created HERE — inside the gated thunk — so a slice that
    // queued behind others still gets a whole budget rather than inheriting one
    // that was ticking while it waited.
    const response = await fetch(`${baseURL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(EMBED_ROUND_TRIP_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.config.model,
        input: slice,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new EmbeddingProviderError('ollama', response.status, this.config.model, body);
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
