// Mock implementation of InferenceClient for testing

import { ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredReadError, StructuredResponse } from '../interface.js';

// Generous defaults so existing consumers never trip chunking or window
// guards unless a test injects tighter limits deliberately.
const GENEROUS_LIMITS: InferenceLimits = {
  contextTokens: 1_000_000,
  maxOutputTokens: 1_000_000,
};

export class MockInferenceClient implements InferenceClient {
  readonly type = 'mock' as const;
  readonly modelId = 'mock-model' as const;
  private responses: string[] = [];
  private responseIndex: number = 0;
  private stopReasons: string[] = [];
  private injectedLimits: InferenceLimits;
  public calls: Array<{ prompt: string; maxTokens: number; temperature: number; elementSchema?: ElementSchema }> = [];

  constructor(responses: string[] = ['Mock response'], stopReasons?: string[], limits?: InferenceLimits) {
    this.responses = responses;
    this.stopReasons = stopReasons || responses.map(() => 'end_turn');
    this.injectedLimits = limits ?? GENEROUS_LIMITS;
  }

  async limits(): Promise<InferenceLimits> {
    return this.injectedLimits;
  }

  async generateText(prompt: string, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature, signal);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<InferenceResponse> {
    throwIfAborted(signal);
    this.calls.push({ prompt, maxTokens, temperature });
    return this.nextResponse();
  }

  /**
   * Structured surface: pops the same responses queue and PARSES the entry,
   * mirroring the real contract — a queued string that is not a JSON array
   * throws "could not be read", so tests inject the malformed shape simply by
   * queuing it (`setResponses(['not json'])`). The element schema is recorded
   * on `calls` so tests can assert what the caller declared.
   */
  async generateStructured<T>(
    prompt: string,
    maxTokens: number,
    temperature: number,
    elementSchema: ElementSchema,
    signal?: AbortSignal,
  ): Promise<StructuredResponse<T>> {
    throwIfAborted(signal);
    this.calls.push({ prompt, maxTokens, temperature, elementSchema });
    const { text, stopReason } = this.nextResponse();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new StructuredReadError('response is not valid JSON', stopReason, { cause: err });
    }
    if (!Array.isArray(parsed)) {
      throw new StructuredReadError(`parsed to ${typeof parsed}, not an array`, stopReason);
    }
    return { items: parsed as T[], stopReason };
  }

  private nextResponse(): InferenceResponse {
    const text = this.responses[this.responseIndex];
    const stopReason = this.stopReasons[this.responseIndex] || 'end_turn';

    if (this.responseIndex < this.responses.length - 1) {
      this.responseIndex++;
    }

    return { text, stopReason };
  }

  // Test helper methods
  reset(): void {
    this.calls = [];
    this.responseIndex = 0;
  }

  setResponses(responses: string[], stopReasons?: string[]): void {
    this.responses = responses;
    this.stopReasons = stopReasons || responses.map(() => 'end_turn');
    this.responseIndex = 0;
  }
}

/**
 * The mock honors the signal like a real adapter (ABANDONED-INFERENCE P1's
 * accept-and-drop trap: an adapter that takes the parameter and ignores it
 * lets cancellation tests pass while proving nothing). The mock resolves
 * synchronously, so an entry check is the whole contract — rejecting the way
 * an aborted `fetch` does, with an `AbortError`-named DOMException.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('This operation was aborted', 'AbortError');
  }
}
