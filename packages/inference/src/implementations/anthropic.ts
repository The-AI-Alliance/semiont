// Anthropic Claude implementation of InferenceClient interface

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@semiont/core';
import { recordInferenceUsage } from '@semiont/observability';
import { InferenceClient, InferenceOptions, InferenceResponse } from '../interface.js';

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
    // Anthropic has no grammar-constrained sampling layer like Ollama's
    // `format: "json"`. The closest equivalent is *prefill*: add an
    // assistant turn whose content is the opening bracket of the
    // expected structure. Claude continues from there, syntactically
    // committed to producing valid JSON. The prefill characters don't
    // appear in the response, so we prepend them ourselves on return.
    //
    // We assume `[` (array) — every current caller of the inference
    // layer that asks for JSON expects an array (entity extraction,
    // motivation detection). If an object-emitting caller appears, the
    // option needs to grow a `root: 'array' | 'object'` field; for now
    // a single shape keeps the contract small.
    const jsonMode = options?.format === 'json';
    const prefill = jsonMode ? '[' : undefined;

    this.logger?.debug('Generating text with inference client', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature,
      format: options?.format,
    });

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: prompt },
    ];
    if (prefill) {
      messages.push({ role: 'assistant', content: prefill });
    }

    const start = performance.now();
    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      response = await this.client.messages.create({
        model: this.modelId,
        max_tokens: maxTokens,
        temperature,
        messages,
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

    recordInferenceUsage({
      provider: this.type,
      model: this.modelId,
      durationMs: performance.now() - start,
      outcome: 'success',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    // Re-attach the prefill prefix so the returned text is what the caller
    // *would have seen* if Anthropic had a native JSON mode — a complete,
    // parseable JSON document. Without this, the consumer would get the
    // tail (`{...}, {...}]`) and parse-fail trying to read it as a top-
    // level array.
    const text = prefill ? prefill + textContent.text : textContent.text;

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
