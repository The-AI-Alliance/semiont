// Anthropic Claude implementation of InferenceClient interface

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@semiont/core';
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
// guarantee is a *tool call*. We offer exactly one tool and force it via
// `tool_choice`, so the model must answer by filling the tool's input — which
// the API serializes as properly-escaped JSON.
//
// A tool's input must be an *object*, so the array is carried under `items`.
// (Phase 3 of STRUCTURED-INFERENCE makes this strict and threads the caller's
// element schema in place of `items: {}`; Phase 5 asks whether the tool
// should exist at all once `output_config.format` is established.)
const JSON_ARRAY_TOOL: Anthropic.Tool = {
  name: 'emit_json_array',
  description:
    'Return your entire answer by calling this tool. Put the JSON array of results under the "items" property, and emit no prose.',
  input_schema: {
    type: 'object',
    properties: {
      // Element shape is unconstrained here — the prompt carries the per-element
      // schema; the tool only enforces that the top-level result is an array.
      items: { type: 'array', items: {} },
    },
    required: ['items'],
  },
};

export class AnthropicInferenceClient implements InferenceClient {
  readonly type = 'anthropic' as const;
  readonly modelId: string;
  private client: Anthropic;
  private logger?: Logger;
  private limitsPromise?: Promise<InferenceLimits>;

  constructor(apiKey: string, model: string, baseURL?: string, logger?: Logger) {
    this.client = new Anthropic({
      apiKey,
      baseURL: baseURL || 'https://api.anthropic.com',
    });
    this.modelId = model;
    this.logger = logger;
  }

  limits(): Promise<InferenceLimits> {
    if (!this.limitsPromise) {
      this.limitsPromise = this.discoverLimits().catch((err: unknown) => {
        // Never cache a failed discovery — a transient outage would otherwise
        // pin every future call to the same rejection.
        this.limitsPromise = undefined;
        throw err;
      });
    }
    return this.limitsPromise;
  }

  private async discoverLimits(): Promise<InferenceLimits> {
    // The Models API publishes the actual ceilings per model — no
    // hand-maintained table to go stale when a new model ships.
    const info = await this.client.models.retrieve(this.modelId).catch((err: unknown) => {
      throw new Error(
        `Failed to discover model limits for '${this.modelId}' from the Models API`,
        { cause: err },
      );
    });
    if (info.max_input_tokens == null || info.max_tokens == null) {
      throw new Error(`Models API reports no context/output ceilings for '${this.modelId}'`);
    }
    return { contextTokens: info.max_input_tokens, maxOutputTokens: info.max_tokens };
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
    _elementSchema: ElementSchema,
  ): Promise<StructuredResponse<T>> {
    // Phase 2 of STRUCTURED-INFERENCE: the schema parameter is accepted but
    // not yet threaded into the tool (`items: {}` stands until Phase 3 makes
    // the tool strict and element-typed). The load-bearing change here is the
    // return path: unreadable input THROWS instead of coercing to [].
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
      // Force the structured-output tool. No prefill assistant turn: the
      // constraint lives in the tool call, not in free text.
      tools: [JSON_ARRAY_TOOL],
      tool_choice: { type: 'tool' as const, name: JSON_ARRAY_TOOL.name },
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
