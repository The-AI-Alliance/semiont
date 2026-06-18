// Anthropic Claude implementation of InferenceClient interface

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@semiont/core';
import { recordInferenceUsage } from '@semiont/observability';
import { InferenceClient, InferenceOptions, InferenceResponse } from '../interface.js';

// Forced-tool channel for JSON mode. Anthropic has no grammar-constrained
// sampling like Ollama's `format`; the equivalent hard guarantee is a *tool
// call*. We offer exactly one tool and force it via `tool_choice`, so the model
// must answer by filling the tool's input — which the API serializes as
// properly-escaped JSON. That kills both free-text failure modes at the source:
// trailing prose after the `]` (variant 1) and an unescaped `"` inside a string
// (variant 2), neither of which a prefill could prevent.
//
// A tool's input must be an *object*, so the array is carried under `items`
// and unwrapped on return (see generateTextWithMetadata) — the caller still
// receives a top-level JSON array in `text`, exactly as on Ollama.
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

  constructor(apiKey: string, model: string, baseURL?: string, logger?: Logger) {
    this.client = new Anthropic({
      apiKey,
      baseURL: baseURL || 'https://api.anthropic.com',
    });
    this.modelId = model;
    this.logger = logger;
  }

  async generateText(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature, options);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<InferenceResponse> {
    const jsonMode = options?.format === 'json';

    this.logger?.debug('Generating text with inference client', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature,
      format: options?.format,
    });

    const start = performance.now();
    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      response = await this.client.messages.create({
        model: this.modelId,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content: prompt }],
        // JSON mode → force the structured-output tool. No prefill assistant
        // turn: the constraint now lives in the tool call, not in free text.
        ...(jsonMode
          ? { tools: [JSON_ARRAY_TOOL], tool_choice: { type: 'tool' as const, name: JSON_ARRAY_TOOL.name } }
          : {}),
      });
    } catch (err) {
      recordInferenceUsage({
        provider: this.type,
        model: this.modelId,
        durationMs: performance.now() - start,
        outcome: 'error',
      });
      throw err;
    }

    this.logger?.debug('Inference response received', {
      model: this.modelId,
      contentBlocks: response.content.length,
      stopReason: response.stop_reason
    });

    let text: string;
    if (jsonMode) {
      // The answer arrives as a tool_use block, not text. Unwrap the `items`
      // array and re-serialize it so `text` is a complete, parseable top-level
      // JSON array — the cross-provider contract every consumer reads.
      const toolUse = response.content.find(c => c.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        recordInferenceUsage({
          provider: this.type,
          model: this.modelId,
          durationMs: performance.now() - start,
          outcome: 'error',
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        });
        this.logger?.error('No tool_use content in inference response', {
          model: this.modelId,
          contentTypes: response.content.map(c => c.type)
        });
        throw new Error('No tool_use content in inference response');
      }
      // `input` is typed `unknown` by the SDK. A truncated (`max_tokens`)
      // response may carry partial or absent `items` — fall back to the partial
      // array, or `[]` if absent; the consumer flags truncation via stopReason.
      const input = toolUse.input as { items?: unknown };
      const items = Array.isArray(input.items) ? input.items : [];
      text = JSON.stringify(items);
    } else {
      const textContent = response.content.find(c => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        recordInferenceUsage({
          provider: this.type,
          model: this.modelId,
          durationMs: performance.now() - start,
          outcome: 'error',
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        });
        this.logger?.error('No text content in inference response', {
          model: this.modelId,
          contentTypes: response.content.map(c => c.type)
        });
        throw new Error('No text content in inference response');
      }
      text = textContent.text;
    }

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
}
