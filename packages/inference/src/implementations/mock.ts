// Mock implementation of InferenceClient for testing

import { InferenceClient, InferenceLimits, InferenceOptions, InferenceResponse } from '../interface.js';

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
  public calls: Array<{ prompt: string; maxTokens: number; temperature: number; options?: InferenceOptions }> = [];

  constructor(responses: string[] = ['Mock response'], stopReasons?: string[], limits?: InferenceLimits) {
    this.responses = responses;
    this.stopReasons = stopReasons || responses.map(() => 'end_turn');
    this.injectedLimits = limits ?? GENEROUS_LIMITS;
  }

  async limits(): Promise<InferenceLimits> {
    return this.injectedLimits;
  }

  async generateText(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature, options);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<InferenceResponse> {
    this.calls.push({ prompt, maxTokens, temperature, ...(options ? { options } : {}) });

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
