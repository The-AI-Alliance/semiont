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
   * (`format: "json"`); Anthropic uses forced structured tool-use (a
   * single tool, forced via `tool_choice`, whose array result the API
   * serializes as escaped JSON) and unwraps the array on return.
   * Callers can rely on the returned `text` being a top-level JSON
   * array regardless of provider.
   *
   * Current callers all expect arrays (entity extraction, motivation
   * detection). If an object-emitting caller appears, this option
   * grows a `root: 'array' | 'object'` field; do not silently drop
   * the constraint.
   */
  format?: 'json';
}

/**
 * A provider's actual ceilings for the configured model, discovered from the
 * provider itself (Anthropic Models API; Ollama `/api/show`) — never
 * hand-maintained constants. Detection budget arithmetic derives from these.
 */
export interface InferenceLimits {
  /**
   * The context window in tokens. Semantics differ by provider shape:
   * Anthropic reports maximum *input* tokens (output has its own ceiling);
   * Ollama reports the *shared* input+output window and mirrors it in
   * `maxOutputTokens` (there is no separate output ceiling), so
   * `maxOutputTokens === contextTokens` signals a shared window.
   */
  contextTokens: number;
  /** Maximum output tokens per generation. */
  maxOutputTokens: number;
}

export interface InferenceClient {
  /** Provider type identifier (e.g. 'anthropic', 'ollama') */
  readonly type: string;

  /** Model identifier used for generation (e.g. 'claude-opus-4-6', 'llama3') */
  readonly modelId: string;

  /**
   * The provider's actual context/output ceilings for `modelId`. Discovered
   * lazily on first call and cached for the client's lifetime; a failed
   * discovery is NOT cached — the next call retries. Throws when the ceilings
   * cannot be determined (unknown model, discovery endpoint unreachable):
   * fail-loud, never a guessed floor.
   */
  limits(): Promise<InferenceLimits>;

  /**
   * Generate text from a prompt (simple interface)
   */
  generateText(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<string>;

  /**
   * Generate text with detailed response information
   */
  generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, options?: InferenceOptions): Promise<InferenceResponse>;
}
