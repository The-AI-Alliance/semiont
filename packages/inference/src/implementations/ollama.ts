// Ollama implementation of InferenceClient interface
// Uses native Ollama HTTP API (no SDK dependency)

import { estimateTokens, isNumber, isObject } from '@semiont/core';
import type { Logger } from '@semiont/core';
import { recordInferenceUsage } from '@semiont/observability';
import { InferenceClient, InferenceLimits, InferenceOptions, InferenceResponse } from '../interface.js';

// Slack added to the chars/4 prompt estimate when sizing `num_ctx`:
// proportional to the estimate (the heuristic's error grows with prompt size)
// plus a small fixed allowance for the model's chat template. The risk profile
// is asymmetric — an undersized window silently clips input (the exact hole
// managed num_ctx exists to close) while an oversized one only costs memory —
// so the slack leans generous. Always capped at the model's real window.
const NUM_CTX_ESTIMATE_SLACK = 0.2;
const NUM_CTX_TEMPLATE_ALLOWANCE = 64;

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

  private limitsPromise?: Promise<InferenceLimits>;

  constructor(model: string, baseURL?: string, logger?: Logger) {
    this.baseURL = (baseURL || 'http://localhost:11434').replace(/\/+$/, '');
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
    const res = await fetch(`${this.baseURL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelId }),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to discover model limits: /api/show returned ${res.status} for '${this.modelId}'`,
      );
    }
    const data: unknown = await res.json();
    const modelInfo = isObject(data) && isObject(data['model_info']) ? data['model_info'] : undefined;
    const contextTokens = readContextLength(modelInfo);
    if (contextTokens === undefined) {
      throw new Error(`/api/show reports no context length for '${this.modelId}'`);
    }
    // Shared window: input and output draw from the same context — there is
    // no separate output ceiling, so the window is published as both (the
    // `maxOutputTokens === contextTokens` shape consumers key the split on).
    return { contextTokens, maxOutputTokens: contextTokens };
  }

  async generateText(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature, options);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<InferenceResponse> {
    this.logger?.debug('Generating text with Ollama', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature,
      format: options?.format,
    });

    // Managed context window: size num_ctx to cover this request, capped at
    // the model's discovered window. Without an explicit num_ctx Ollama uses
    // the model's *default* window and SILENTLY CLIPS any prompt beyond it —
    // input loss with no error (found 2026-07-30).
    const limits = await this.limits();
    const promptTokens = estimateTokens(prompt);
    if (promptTokens + maxTokens > limits.contextTokens) {
      throw new Error(
        `Prompt (~${promptTokens} tokens) + output budget (${maxTokens}) exceed the ` +
        `'${this.modelId}' context window (${limits.contextTokens} tokens)`,
      );
    }
    const numCtx = Math.min(
      limits.contextTokens,
      promptTokens + maxTokens
        + Math.ceil(promptTokens * NUM_CTX_ESTIMATE_SLACK) + NUM_CTX_TEMPLATE_ALLOWANCE,
    );

    const url = `${this.baseURL}/api/generate`;
    const start = performance.now();

    // Ollama's `format` parameter accepts either the literal string
    // `"json"` (any valid JSON, including objects, numbers, etc.) or a
    // JSON schema (constrains the top-level shape). The contract on the
    // inference side is "parseable JSON array," so we pass a minimal
    // array schema rather than the bare `"json"` string — without it,
    // the model can satisfy "valid JSON" by emitting `{"entities": [...]}`
    // and break every consumer that expects to call `.map` on the
    // top-level value. The schema's `items: {}` keeps element shape
    // unconstrained — the prompt still carries the per-element schema;
    // we only enforce the outer array.
    const body: Record<string, unknown> = {
      model: this.modelId,
      prompt,
      stream: false,
      think: false,
      options: {
        num_predict: maxTokens,
        num_ctx: numCtx,
        temperature,
      },
    };
    if (options?.format === 'json') {
      body['format'] = { type: 'array', items: {} };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

/**
 * The context length lives in `model_info` under an architecture-prefixed key
 * (e.g. `llama.context_length`); `general.architecture` names the prefix.
 * Falls back to any `*.context_length` key for models whose metadata omits
 * the architecture field.
 */
function readContextLength(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  const arch = modelInfo['general.architecture'];
  if (typeof arch === 'string') {
    const direct = modelInfo[`${arch}.context_length`];
    if (isNumber(direct) && direct > 0) return direct;
  }
  const fallbackKey = Object.keys(modelInfo).find(k => k.endsWith('.context_length'));
  if (fallbackKey !== undefined) {
    const fallback = modelInfo[fallbackKey];
    if (isNumber(fallback) && fallback > 0) return fallback;
  }
  return undefined;
}

function mapStopReason(doneReason: string | undefined): string {
  switch (doneReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    default: return doneReason || 'unknown';
  }
}
