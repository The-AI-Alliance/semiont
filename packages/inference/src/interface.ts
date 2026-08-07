// Inference client interface - all implementations must follow this contract

export interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}

/**
 * Raw JSON Schema for ONE array element of a structured generation — a plain
 * object, not a TS type and not a validator instance. Both providers consume
 * JSON Schema directly (Anthropic nests it under the forced tool's
 * `input_schema`; Ollama sends it as `format: { type: 'array', items: … }`),
 * so anything richer would abstract one shape with two consumers.
 *
 * Constrain it to what both providers enforce: objects,
 * `string`/`number`/`boolean`/`null`, `enum`, `const`, `required`, and
 * `additionalProperties: false`. Numeric and string constraints (`minimum`,
 * `maxLength`) are NOT enforced by Anthropic strict mode — declaring them
 * buys nothing and misleads the reader.
 */
export type ElementSchema = Record<string, unknown>;

/**
 * A structured generation's result: the elements the model produced, plus the
 * provider's stop reason (consumers gate on 'max_tokens' — truncation is data
 * loss, not "fewer items").
 *
 * `items` is `T[]`, never a string: there is no representable value meaning
 * "here is some text I could not read." An implementation that cannot deliver
 * the array THROWS — failure is distinct from empty by construction.
 *
 * `T` is a caller assertion, not a runtime guarantee: nothing verifies the
 * element schema and `T` agree, and the type parameter is erased. Declare the
 * schema and `T` adjacently at the call site so drift is visible in one
 * place, and keep per-element structural guards on the consuming side.
 */
export interface StructuredResponse<T> {
  items: T[];
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
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
  generateText(prompt: string, maxTokens: number, temperature: number): Promise<string>;

  /**
   * Generate text with detailed response information
   */
  generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number): Promise<InferenceResponse>;

  /**
   * Generate a JSON array whose elements satisfy `elementSchema`, as parsed
   * values — the structured counterpart of `generateTextWithMetadata`, and
   * the ONLY generation surface detection may use.
   *
   * The return type carries the guarantee the old `format: 'json'` option
   * left in a comment: callers receive `T[]` or an exception. When the
   * provider's answer cannot be read as an array (the SDK hands tool input
   * over as an unparsed string, the response is missing the array, the
   * grammar was not honoured), implementations THROW a
   * "Structured response could not be read" error — they never coerce to
   * `[]`, because empty is a legitimate, distinct outcome.
   */
  generateStructured<T>(
    prompt: string,
    maxTokens: number,
    temperature: number,
    elementSchema: ElementSchema,
  ): Promise<StructuredResponse<T>>;
}
