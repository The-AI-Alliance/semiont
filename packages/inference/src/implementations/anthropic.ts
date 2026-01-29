// Anthropic Claude implementation of InferenceClient interface

import Anthropic from '@anthropic-ai/sdk';
import { InferenceClient, InferenceResponse } from '../interface.js';

export class AnthropicInferenceClient implements InferenceClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new Anthropic({
      apiKey,
      baseURL: baseURL || 'https://api.anthropic.com',
    });
    this.model = model;
  }

  async generateText(prompt: string, maxTokens: number, temperature: number): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number): Promise<InferenceResponse> {
    console.log('generateText called with prompt length:', prompt.length, 'maxTokens:', maxTokens, 'temp:', temperature);

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

    console.log('Inference response received, content blocks:', response.content.length);

    const textContent = response.content.find(c => c.type === 'text');

    if (!textContent || textContent.type !== 'text') {
      console.error('No text content in response:', response.content);
      throw new Error('No text content in inference response');
    }

    console.log('Returning text content of length:', textContent.text.length);

    return {
      text: textContent.text,
      stopReason: response.stop_reason || 'unknown'
    };
  }
}
