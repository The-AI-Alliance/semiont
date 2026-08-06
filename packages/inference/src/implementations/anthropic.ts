// Anthropic Claude implementation of InferenceClient interface

import Anthropic from '@anthropic-ai/sdk';
import { isObject, type Logger } from '@semiont/core';
import { recordInferenceUsage } from '@semiont/observability';
import { ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredResponse } from '../interface.js';

// The SDK refuses non-streaming create() calls whose projected duration
// exceeds its 10-minute timeout: it throws when
// (60min × max_tokens) / 128_000 > 10min, i.e. above 128_000/6 ≈ 21,333
// output tokens (client.js, calculateNonstreamingTimeout). Above that we
// stream internally and assemble the final message — same request shape,
// same response handling, same interface.
const NONSTREAMING_MAX_OUTPUT_TOKENS = Math.floor(128_000 / 6);

// Forced-tool channel for structured generation. Anthropic has no
// grammar-constrained sampling like Ollama's `format`; the equivalent hard
// guarantee is STRICT tool use — `strict: true` makes the API validate the
// tool input against the schema, so the serialized JSON is both well-escaped
// AND shape-conformant. We offer exactly one tool and force it via
// `tool_choice`.
//
// A tool's input must be an *object*, so the array is carried under `items`,
// with the caller's element schema constraining each element and a closed
// wrapper (`additionalProperties: false` — required by strict mode, and
// measured enforced on both live-config models, 2026-08-06).
// (STRUCTURED-INFERENCE Phase 5 asks whether the tool should exist at all
// once `output_config.format`'s root constraints are established.)
function jsonArrayTool(elementSchema: Record<string, unknown>): Anthropic.Tool {
  return {
    name: 'emit_json_array',
    description:
      'Return your entire answer by calling this tool. Put the JSON array of results under the "items" property, and emit no prose.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: elementSchema },
      },
      required: ['items'],
      additionalProperties: false,
    },
  };
}

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
      limits: { contextTokens: info.max_input_tokens, maxOutputTokens: info.max_tokens },
      structuredOutputsSupported,
    };
  }

  private requestMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    if (params.max_tokens > NONSTREAMING_MAX_OUTPUT_TOKENS) {
      return this.client.messages.stream(params).finalMessage();
    }
    return this.client.messages.create(params);
  }

  async generateText(prompt: string, maxTokens: number, temperature: number): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number): Promise<InferenceResponse> {
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
    const response = await this.recordedRequest(params, start);

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
      stopReason: response.stop_reason
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

    const tool = jsonArrayTool(elementSchema);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelId,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
      // Force the structured-output tool. No prefill assistant turn: the
      // constraint lives in the (strict) tool call, not in free text.
      tools: [tool],
      tool_choice: { type: 'tool' as const, name: tool.name },
    };

    const start = performance.now();
    const response = await this.recordedRequest(params, start);

    const toolUse = response.content.find(c => c.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      this.recordError(start, response);
      this.logger?.error('No tool_use content in inference response', {
        model: this.modelId,
        contentTypes: response.content.map(c => c.type)
      });
      throw new Error('No tool_use content in inference response');
    }

    // `input` is typed `unknown` by the SDK. When the SDK cannot parse the
    // accumulated tool-input JSON (live case: one invalid escape in a 67 K
    // payload), it delivers `items` as a STRING — and a truncated response
    // may omit it entirely. Both are "we could not read the model," which
    // must never be conflated with "the model found nothing": the old
    // `Array.isArray(items) ? items : []` fallback silently discarded 202
    // real entities as a green empty result. Unreadable is a THROW.
    const input = toolUse.input as { items?: unknown };
    if (!Array.isArray(input.items)) {
      this.recordError(start, response);
      const shape = typeof input.items;
      this.logger?.error('Structured response could not be read', {
        model: this.modelId,
        itemsType: shape,
        stopReason: response.stop_reason,
        ...(typeof input.items === 'string' ? { itemsLength: input.items.length } : {}),
      });
      throw new Error(
        `Structured response could not be read: items is ${shape === 'undefined' ? 'absent' : `a ${shape}, not an array`} (stop_reason: ${response.stop_reason})`,
      );
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
      items: input.items.length,
      stopReason: response.stop_reason
    });

    return {
      items: input.items as T[],
      stopReason: response.stop_reason || 'unknown',
    };
  }

  /** Issue the request, recording an error metric if the transport throws. */
  private async recordedRequest(params: Anthropic.MessageCreateParamsNonStreaming, start: number): Promise<Anthropic.Message> {
    try {
      return await this.requestMessage(params);
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
