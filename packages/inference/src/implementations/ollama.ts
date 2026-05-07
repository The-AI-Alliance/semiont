// Ollama implementation of InferenceClient interface
// Uses native Ollama HTTP API (no SDK dependency)

import type { Logger } from '@semiont/core';
import { recordInferenceUsage } from '@semiont/observability';
import { InferenceClient, InferenceResponse } from '../interface.js';

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
  done_reason?: string;
  /** Number of prompt tokens evaluated. Available on most Ollama versions. */
  prompt_eval_count?: number;
  /** Number of tokens generated. */
  eval_count?: number;
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
    const start = performance.now();

    let res: Response;
    try {
      res = await fetch(url, {
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
    } catch (err) {
      recordInferenceUsage({
        provider: this.type,
        model: this.modelId,
        durationMs: performance.now() - start,
        outcome: 'error',
      });
      throw err;
    }

    if (!res.ok) {
      recordInferenceUsage({
        provider: this.type,
        model: this.modelId,
        durationMs: performance.now() - start,
        outcome: 'error',
      });
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
      recordInferenceUsage({
        provider: this.type,
        model: this.modelId,
        durationMs: performance.now() - start,
        outcome: 'error',
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
      });
      this.logger?.error('Empty response from Ollama', { model: this.modelId });
      throw new Error('Empty response from Ollama');
    }

    recordInferenceUsage({
      provider: this.type,
      model: this.modelId,
      durationMs: performance.now() - start,
      outcome: 'success',
      inputTokens: data.prompt_eval_count,
      outputTokens: data.eval_count,
    });

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
