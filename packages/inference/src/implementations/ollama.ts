// Ollama implementation of InferenceClient interface
// Uses native Ollama HTTP API (no SDK dependency)

import type { Logger } from '@semiont/core';
import { InferenceClient, InferenceResponse } from '../interface.js';

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
  done_reason?: string;
}

export class OllamaInferenceClient implements InferenceClient {
  readonly type = 'ollama' as const;
  readonly modelId: string;
  private baseURL: string;
  private logger?: Logger;

  constructor(model: string, baseURL?: string, logger?: Logger) {
    this.baseURL = (baseURL || 'http://localhost:11434').replace(/\/+$/, '');
    this.modelId = model;
    this.logger = logger;
  }

  async generateText(prompt: string, maxTokens: number, temperature: number): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number): Promise<InferenceResponse> {
    this.logger?.debug('Generating text with Ollama', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature
    });

    const url = `${this.baseURL}/api/generate`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelId,
        prompt,
        stream: false,
        think: false,
        options: {
          num_predict: maxTokens,
          temperature,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger?.error('Ollama API error', {
        model: this.modelId,
        status: res.status,
        body,
      });
      throw new Error(`Ollama API error (${res.status}): ${body}`);
    }

    const data = await res.json() as OllamaGenerateResponse;

    if (!data.response) {
      this.logger?.error('Empty response from Ollama', { model: this.modelId });
      throw new Error('Empty response from Ollama');
    }

    const stopReason = mapStopReason(data.done_reason);

    this.logger?.info('Text generation completed', {
      model: this.modelId,
      textLength: data.response.length,
      stopReason,
    });

    return {
      text: data.response,
      stopReason,
    };
  }
}

function mapStopReason(doneReason: string | undefined): string {
  switch (doneReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    default: return doneReason || 'unknown';
  }
}
