// Mock implementation of InferenceClient for testing

import { InferenceClient, InferenceResponse } from '../interface.js';

export class MockInferenceClient implements InferenceClient {
  private responses: string[] = [];
  private responseIndex: number = 0;
  private stopReasons: string[] = [];
  public calls: Array<{ prompt: string; maxTokens: number; temperature: number }> = [];

  constructor(responses: string[] = ['Mock response'], stopReasons?: string[]) {
    this.responses = responses;
    this.stopReasons = stopReasons || responses.map(() => 'end_turn');
  }

  async generateText(prompt: string, maxTokens: number, temperature: number): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number): Promise<InferenceResponse> {
    this.calls.push({ prompt, maxTokens, temperature });

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
