// Anthropic Claude implementation of InferenceClient interface

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@semiont/core';
import { InferenceClient, InferenceResponse } from '../interface.js';

export class AnthropicInferenceClient implements InferenceClient {
  private client: Anthropic;
  private model: string;
  private logger?: Logger;

  constructor(apiKey: string, model: string, baseURL?: string, logger?: Logger) {
    this.client = new Anthropic({
      apiKey,
      baseURL: baseURL || 'https://api.anthropic.com',
    });
    this.model = model;
    this.logger = logger;
  }

  async generateText(prompt: string, maxTokens: number, temperature: number): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number): Promise<InferenceResponse> {
    this.logger?.debug('Generating text with inference client', {
      model: this.model,
      promptLength: prompt.length,
      maxTokens,
      temperature
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    this.logger?.debug('Inference response received', {
      model: this.model,
      contentBlocks: response.content.length,
      stopReason: response.stop_reason
    });

    const textContent = response.content.find(c => c.type === 'text');

    if (!textContent || textContent.type !== 'text') {
      this.logger?.error('No text content in inference response', {
        model: this.model,
        contentTypes: response.content.map(c => c.type)
      });
      throw new Error('No text content in inference response');
    }

    this.logger?.info('Text generation completed', {
      model: this.model,
      textLength: textContent.text.length,
      stopReason: response.stop_reason
    });

    return {
      text: textContent.text,
      stopReason: response.stop_reason || 'unknown'
    };
  }
}
