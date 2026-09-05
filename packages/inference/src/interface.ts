// Inference client interface - all implementations must follow this contract

/**
 * What the call actually cost, as the PROVIDER counted it — never estimated
 * here. Optional because a provider may not report it (and a call that fails
 * before generating has nothing to report); absent means unknown, and a
 * consumer must treat it as unknown rather than substituting a guess.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
  usage?: TokenUsage;
}

/**
 * Raw JSON Schema for ONE array element of a structured generation — a plain
 * object, not a TS type and not a validator instance. Both providers consume
 * JSON Schema directly (Anthropic as the array-root schema under
 * `output_config.format`; Ollama as `format: { type: 'array', items: … }`),
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
  usage?: TokenUsage;
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
  /**
   * The provider's own worst-case output-rate model, in output tokens per
   * hour, when it publishes one. Anthropic's SDK projects a call's maximum
   * duration as `max_tokens / rate` (client.js `calculateNonstreamingTimeout`,
   * 128_000/hour) and refuses non-streaming calls projected past 10 minutes —
   * the one duration statement that provider surface makes. Consumers with
   * their own call deadline derive a duration-safe output budget from it
   * (ABANDONED-INFERENCE P4). Absent for providers whose rates are
   * unknowable (Ollama — local hardware), where no duration bound applies.
   */
  outputTokensPerHour?: number;
}

/**
 * Thrown when a structured generation's response cannot be read as the
 * requested array — never coerced to `[]` (empty is a legitimate, distinct
 * outcome). One class for every implementation, because the message shape
 * and the classification contract must not diverge between providers.
 *
 * Carries the provider's stop reason because the cause classifies
 * differently downstream: `max_tokens` means the JSON was cut off by the
 * output budget — the same input truncates the same way, so a retry is
 * guaranteed waste — while any other reason is model misbehavior a retry
 * may legitimately fix.
 */
export class StructuredReadError extends Error {
  override readonly name = 'StructuredReadError';
  constructor(detail: string, readonly stopReason: string, options?: ErrorOptions) {
    super(`Structured response could not be read: ${detail} (stop_reason: ${stopReason})`, options);
  }
}

export interface InferenceClient {
  /** Provider type identifier (e.g. 'anthropic', 'ollama') */
  readonly type: string;

  /** Model identifier used for generation (e.g. 'claude-opus-4-6', 'llama3') */
  readonly modelId: string;

  /**
   * How many INDEPENDENT inference calls a caller should run concurrently
   * against this provider for a throughput gain (DETECTION-QUALITY-THROUGHPUT
   * P6 — detection's per-type fan-out reads this).
   *
   * This is a property of the provider's economics, which is why it lives on
   * the provider and not in the caller. A HOSTED API whose per-account rate
   * limit sits far above one job's usage has real spare capacity, so >1
   * genuinely parallelizes. A LOCAL single-model server (Ollama) is 1: its
   * throughput is hardware-bound, so concurrent requests only queue or split
   * one GPU — no aggregate speedup, and N live KV-cache contexts is memory
   * pressure that can OOM. There is no honest default across those two worlds,
   * so this is required, not optional.
   *
   * Hard-coded per implementation for now; the natural seam for future
   * per-provider or admin tuning (a value that later comes from config changes
   * only where this is SET, not the callers).
   */
  readonly maxConcurrency: number;

  /**
   * The provider's actual context/output ceilings for `modelId`. Discovered
   * lazily on first call and cached for the client's lifetime; a failed
   * discovery is NOT cached — the next call retries. Throws when the ceilings
   * cannot be determined (unknown model, discovery endpoint unreachable):
   * fail-loud, never a guessed floor.
   */
  limits(): Promise<InferenceLimits>;

  /**
   * Generate text from a prompt (simple interface).
   *
   * `signal` (here and on every generation method — a trailing optional
   * parameter, deliberately not an options bag; STRUCTURED-INFERENCE removed
   * that shape on purpose): true cancellation, ABANDONED-INFERENCE P1.
   * Implementations MUST thread it to their transport so an abort tears down
   * the underlying request — and, for SDKs with internal retry loops, ends
   * those too — rejecting promptly. Accepting the parameter and ignoring it
   * is a defect worse than not having it: cancellation tests pass against
   * such an adapter while zombie requests keep running (and billing) in
   * production.
   */
  generateText(prompt: string, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<string>;

  /**
   * Generate text with detailed response information
   */
  generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<InferenceResponse>;

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
    signal?: AbortSignal,
  ): Promise<StructuredResponse<T>>;
}
