// Inference client interface - all implementations must follow this contract

export interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}

export interface InferenceClient {
  /**
   * Generate text from a prompt (simple interface)
   * @param prompt - The input prompt
   * @param maxTokens - Maximum tokens to generate
   * @param temperature - Sampling temperature (0-1)
   * @returns Generated text
   */
  generateText(prompt: string, maxTokens: number, temperature: number): Promise<string>;

  /**
   * Generate text with detailed response information
   * @param prompt - The input prompt
   * @param maxTokens - Maximum tokens to generate
   * @param temperature - Sampling temperature (0-1)
   * @returns Response with text and metadata
   */
  generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number): Promise<InferenceResponse>;
}
