// Anthropic Claude implementation of InferenceClient interface

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@semiont/core';
import { recordInferenceUsage } from '@semiont/observability';
import { InferenceClient, InferenceResponse } from '../interface.js';

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

  async generateText(prompt: string, maxTokens: number, temperature: number): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number): Promise<InferenceResponse> {
    this.logger?.debug('Generating text with inference client', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature
    });

    const start = performance.now();
    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      response = await this.client.messages.create({
        model: this.modelId,
        max_tokens: maxTokens,
        temperature,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
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

    this.logger?.info('Text generation completed', {
      model: this.modelId,
      textLength: textContent.text.length,
      stopReason: response.stop_reason
    });

    return {
      text: textContent.text,
      stopReason: response.stop_reason || 'unknown'
    };
  }
}
