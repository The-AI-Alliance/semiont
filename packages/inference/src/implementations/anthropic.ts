// Anthropic Claude implementation of InferenceClient interface

import Anthropic from '@anthropic-ai/sdk';
import { isObject, type Logger } from '@semiont/core';
import { recordInferenceUsage } from '@semiont/observability';
import { ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredReadError, StructuredResponse, TokenUsage } from '../interface.js';

// The SDK's worst-case output-rate model: client.js's
// calculateNonstreamingTimeout projects a call's maximum duration as
// (60min × max_tokens) / 128_000 and refuses non-streaming create() calls
// projected past its 10-minute timeout. ONE constant, two derivations: the
// streaming switch below, and `limits().outputTokensPerHour` — the single
// duration statement this provider surface makes, which detection's
// duration budget derives from (ABANDONED-INFERENCE P4). Invalidated if
// the SDK revises its rate model: check calculateNonstreamingTimeout on
// SDK upgrades.
const OUTPUT_TOKENS_PER_HOUR = 128_000;

// Above ~21,333 output tokens (the 10-minute projection) we stream
// internally and assemble the final message — same request shape, same
// response handling, same interface.
const NONSTREAMING_MAX_OUTPUT_TOKENS = Math.floor(OUTPUT_TOKENS_PER_HOUR / 6);

// Structured generation rides `output_config.format` — response-level
// structured output: the response TEXT is the schema-conforming JSON, with a
// top-level ARRAY root (accepted on both live-config models — spike
// 2026-08-06, `.plans/spikes/output-config-array-root.md`). This replaced
// the pre-structured-outputs scaffolding: a forced `emit_json_array` tool
// whose object-only input required an `items` wrapper and an unwrap — and
// the unwrap was the exact line that silently coerced an unreadable payload
// to `[]` (STRUCTURED-INFERENCE §Problem). There is no tool-input
// accumulation step left for the SDK to hand over unparsed; the read path is
// now the same parse-and-verify shape as Ollama's.

/**
 * Everything one Models API call teaches us about the configured model. The
 * capability stays PRIVATE to this client: its only consumer is the gate in
 * `generateStructured`, so it does not cross the `InferenceClient` interface
 * (no speculative surface — widen `InferenceLimits` only when an external
 * consumer exists).
 */
interface ModelDiscovery {
  limits: InferenceLimits;
  structuredOutputsSupported: boolean;
}

export class AnthropicInferenceClient implements InferenceClient {
  readonly type = 'anthropic' as const;
  readonly modelId: string;
  private client: Anthropic;
  private logger?: Logger;
  private discoveryPromise?: Promise<ModelDiscovery>;

  constructor(apiKey: string, model: string, baseURL?: string, logger?: Logger) {
    this.client = new Anthropic({
      apiKey,
      baseURL: baseURL || 'https://api.anthropic.com',
    });
    this.modelId = model;
    this.logger = logger;
  }

  limits(): Promise<InferenceLimits> {
    return this.discover().then(d => d.limits);
  }

  private discover(): Promise<ModelDiscovery> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = this.discoverModel().catch((err: unknown) => {
        // Never cache a failed discovery — a transient outage would otherwise
        // pin every future call to the same rejection.
        this.discoveryPromise = undefined;
        throw err;
      });
    }
    return this.discoveryPromise;
  }

  private async discoverModel(): Promise<ModelDiscovery> {
    // The Models API publishes the actual ceilings AND capabilities per
    // model — no hand-maintained table to go stale when a new model ships,
    // and the API's own metadata outranks documentation prose when the two
    // disagree (measured: the docs' supported-model list was stale while
    // `capabilities.structured_outputs.supported` was correct).
    const info = await this.client.models.retrieve(this.modelId).catch((err: unknown) => {
      throw new Error(
        `Failed to discover model limits for '${this.modelId}' from the Models API`,
        { cause: err },
      );
    });
    if (info.max_input_tokens == null || info.max_tokens == null) {
      throw new Error(`Models API reports no context/output ceilings for '${this.modelId}'`);
    }
    // `capabilities` is not declared on the SDK's ModelInfo type — narrow
    // through the core guards rather than casting. Absent metadata reads as
    // unsupported: the gate then refuses loudly (D4), never guesses.
    const raw: unknown = info;
    const structuredOutputsSupported =
      isObject(raw) &&
      isObject(raw['capabilities']) &&
      isObject(raw['capabilities']['structured_outputs']) &&
      raw['capabilities']['structured_outputs']['supported'] === true;
    return {
      limits: {
        contextTokens: info.max_input_tokens,
        maxOutputTokens: info.max_tokens,
        outputTokensPerHour: OUTPUT_TOKENS_PER_HOUR,
      },
      structuredOutputsSupported,
    };
  }

  private requestMessage(params: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal): Promise<Anthropic.Message> {
    // The signal rides the SDK's RequestOptions: an abort tears down the live
    // attempt AND is checked between the SDK's internal retries, so a
    // cancelled call cannot survive as a background zombie inside the SDK's
    // own retry/backoff loop (ABANDONED-INFERENCE P0 caught one completing
    // 24–34 minutes after abandonment). For visibility into those internal
    // retries themselves, the SDK's ANTHROPIC_LOG=debug env knob logs every
    // attempt — nothing to re-implement here.
    if (params.max_tokens > NONSTREAMING_MAX_OUTPUT_TOKENS) {
      return this.client.messages.stream(params, { signal }).finalMessage();
    }
    return this.client.messages.create(params, { signal });
  }

  async generateText(prompt: string, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature, signal);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<InferenceResponse> {
    this.logger?.debug('Generating text with inference client', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature,
    });

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelId,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    };

    const start = performance.now();
    const response = await this.recordedRequest(params, start, signal);

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      this.recordError(start, response);
      this.logger?.error('No text content in inference response', {
        model: this.modelId,
        contentTypes: response.content.map(c => c.type)
      });
      throw new Error('No text content in inference response');
    }
    const text = textContent.text;

    recordInferenceUsage({
      provider: this.type,
      model: this.modelId,
      durationMs: performance.now() - start,
      outcome: 'success',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    this.logger?.info('Text generation completed', {
      model: this.modelId,
      textLength: text.length,
      stopReason: response.stop_reason,
      requestId: requestIdOf(response),
    });

    return {
      text,
      stopReason: response.stop_reason || 'unknown'
    };
  }

  async generateStructured<T>(
    prompt: string,
    maxTokens: number,
    temperature: number,
    elementSchema: ElementSchema,
    signal?: AbortSignal,
  ): Promise<StructuredResponse<T>> {
    // Capability gate (D3/D4): model choice is deployment config, so the
    // client asks the provider whether the configured model can honour
    // strictness — and REFUSES when it cannot. Silent fallback to
    // unconstrained tool use is exactly the behaviour that turned 202 real
    // entities into a green empty job. The discovery is the same cached
    // Models API call `limits()` uses; no extra round trip.
    const discovery = await this.discover();
    if (!discovery.structuredOutputsSupported) {
      throw new Error(
        `Model '${this.modelId}' does not report support for strict structured outputs ` +
        `(Models API capabilities.structured_outputs) — refusing rather than degrading to ` +
        `unconstrained tool use, which silently discards unreadable results. Re-point the ` +
        `inference.model key that pins this worker/actor in .semiont/semiontconfig/*.toml ` +
        `(e.g. environments.<env>.workers.<job-type>.inference.model) at a model that ` +
        `reports supported: true.`,
      );
    }

    this.logger?.debug('Generating structured output with inference client', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature,
    });

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelId,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
      // Response-level structured output with an ARRAY root: the response
      // text IS the schema-conforming JSON. No tools, no prefill.
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'array', items: elementSchema },
        },
      },
    };

    const start = performance.now();
    const response = await this.recordedRequest(params, start, signal);

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      this.recordError(start, response);
      this.logger?.error('No text content in structured inference response', {
        model: this.modelId,
        contentTypes: response.content.map(c => c.type)
      });
      throw new Error('No text content in structured inference response');
    }

    // Anything that does not read as an array is a THROW, never a coerced
    // `[]` — "we could not read the model" must never be conflated with
    // "the model found nothing": that conflation is what silently discarded
    // 202 real entities as a green empty result. A truncated (`max_tokens`)
    // response surfaces here too, as unparseable JSON naming its stop_reason.
    let parsed: unknown;
    try {
      parsed = JSON.parse(textContent.text);
    } catch (err) {
      this.recordError(start, response);
      this.logger?.error('Structured response could not be read', {
        model: this.modelId,
        textLength: textContent.text.length,
        stopReason: response.stop_reason,
      });
      throw new StructuredReadError('response is not valid JSON', response.stop_reason || 'unknown', { cause: err });
    }
    if (!Array.isArray(parsed)) {
      this.recordError(start, response);
      this.logger?.error('Structured response could not be read', {
        model: this.modelId,
        parsedType: typeof parsed,
        stopReason: response.stop_reason,
      });
      throw new StructuredReadError(`parsed to ${typeof parsed}, not an array`, response.stop_reason || 'unknown');
    }

    recordInferenceUsage({
      provider: this.type,
      model: this.modelId,
      durationMs: performance.now() - start,
      outcome: 'success',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    this.logger?.info('Structured generation completed', {
      model: this.modelId,
      items: parsed.length,
      stopReason: response.stop_reason,
      requestId: requestIdOf(response),
    });

    return {
      items: parsed as T[],
      stopReason: response.stop_reason || 'unknown',
      ...usageOf(response),
    };
  }

  /** Issue the request, recording an error metric if the transport throws. */
  private async recordedRequest(params: Anthropic.MessageCreateParamsNonStreaming, start: number, signal?: AbortSignal): Promise<Anthropic.Message> {
    try {
      return await this.requestMessage(params, signal);
    } catch (err) {
      recordInferenceUsage({
        provider: this.type,
        model: this.modelId,
        durationMs: performance.now() - start,
        outcome: 'error',
      });
      throw err;
    }
  }

  private recordError(start: number, response: Anthropic.Message): void {
    recordInferenceUsage({
      provider: this.type,
      model: this.modelId,
      durationMs: performance.now() - start,
      outcome: 'error',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });
  }
}

/**
 * The provider's request id, for correlating our logs with Anthropic's and
 * telling one attempt from another. The SDK attaches `_request_id` to the
 * returned message at runtime but does not declare it on the `Message` type,
 * so it is read through a guard rather than a cast.
 */
function requestIdOf(response: unknown): string | undefined {
  if (isObject(response) && typeof response['_request_id'] === 'string') {
    return response['_request_id'];
  }
  return undefined;
}

/**
 * The provider's own token counts, shaped for `TokenUsage`. Absent when the
 * SDK reports none — never zero-filled: a zero would read as "this call cost
 * nothing", which is a different claim from "we do not know".
 */
function usageOf(response: { usage?: { input_tokens?: number; output_tokens?: number } }): { usage?: TokenUsage } {
  const { input_tokens, output_tokens } = response.usage ?? {};
  if (input_tokens === undefined || output_tokens === undefined) return {};
  return { usage: { inputTokens: input_tokens, outputTokens: output_tokens } };
}
