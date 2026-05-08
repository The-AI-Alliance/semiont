// Inference client interface - all implementations must follow this contract

export interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}

/**
 * Per-call options. Drift here when output discipline matters more than
 * raw model behavior — e.g. forcing valid JSON for entity extraction
 * where a parse failure in the consumer is silent and useless.
 */
export interface InferenceOptions {
  /**
   * Constrain output to a parseable JSON array. Every implementation
   * MUST satisfy this contract using whatever mechanism its provider
   * supports — Ollama uses grammar-constrained sampling
   * (`format: "json"`); Anthropic uses assistant-turn prefill (`[`)
   * and re-attaches the prefix on return. Callers can rely on the
   * returned `text` being a top-level JSON array regardless of
   * provider.
   *
   * Current callers all expect arrays (entity extraction, motivation
   * detection). If an object-emitting caller appears, this option
   * grows a `root: 'array' | 'object'` field; do not silently drop
   * the constraint.
   */
  format?: 'json';
}

export interface InferenceClient {
  /** Provider type identifier (e.g. 'anthropic', 'ollama') */
  readonly type: string;

  /** Model identifier used for generation (e.g. 'claude-opus-4-6', 'llama3') */
  readonly modelId: string;

  /**
   * Generate text from a prompt (simple interface)
   */
  generateText(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<string>;

  /**
   * Generate text with detailed response information
   */
  generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<InferenceResponse>;
}
