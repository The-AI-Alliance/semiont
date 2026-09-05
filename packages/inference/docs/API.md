# Inference API Reference

## Overview

`@semiont/inference` provides provider-agnostic text generation. The package exports exactly:

- `createInferenceClient` — factory selecting an implementation from config
- `InferenceClient`, `InferenceLimits`, `InferenceResponse`, `StructuredResponse`, `ElementSchema` — the interface types
- `InferenceClientConfig`, `InferenceClientType` — factory config types
- `AnthropicInferenceClient`, `OllamaInferenceClient` — provider implementations
- `MockInferenceClient` — scripted test double

There is no application logic here (no prompt templates, parsing, retries, or context management) — that lives in `@semiont/make-meaning`.

## createInferenceClient

```typescript
import { createInferenceClient, type InferenceClientConfig } from '@semiont/inference';
import type { Logger } from '@semiont/core';

const client = createInferenceClient(config, logger);
```

**Parameters:**
- `config: InferenceClientConfig` — see below
- `logger?: Logger` — optional structured logger from `@semiont/core`

```typescript
interface InferenceClientConfig {
  type: 'anthropic' | 'ollama';
  model: string;        // e.g. 'claude-sonnet-4-6', 'gemma2:9b'
  apiKey?: string;      // anthropic only
  endpoint?: string;    // provider URL
  baseURL?: string;     // fallback when endpoint is not set
}
```

**Throws:**
- `type: 'anthropic'` with a missing or empty `apiKey`
- an unsupported `type`

The factory is synchronous and performs no I/O; the first network call happens on generation.

## InferenceClient

The contract every implementation satisfies:

```typescript
interface InferenceClient {
  readonly type: string;     // 'anthropic' | 'ollama' | 'mock'
  readonly modelId: string;  // configured model name

  // Declared capabilities — consumers read these instead of switching on
  // provider identity; every implementation must take a position (pinned):
  readonly maxConcurrency: number;        // independent calls that gain from running concurrently
  readonly verifyDetectionYield: boolean; // whether detection count-verifies extractions

  limits(): Promise<InferenceLimits>;

  generateText(
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): Promise<string>;

  generateTextWithMetadata(
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal?: AbortSignal
  ): Promise<InferenceResponse>;

  generateStructured<T>(
    prompt: string,
    maxTokens: number,
    temperature: number,
    elementSchema: ElementSchema,
    signal?: AbortSignal
  ): Promise<StructuredResponse<T>>;
}

interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
  usage?: TokenUsage;  // provider-reported token counts; absent = unreported, never zero-filled
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
```

`generateText` is `generateTextWithMetadata` with the metadata dropped.

**Cancellation** (`signal`, trailing optional on every generation method): aborting tears down the underlying transport — Ollama's `fetch`, or the Anthropic SDK request on both its paths, where the SDK also checks the signal between its internal retries — so a cancelled call rejects promptly (`AbortError` / `APIUserAbortError`) rather than surviving as a billed background request. Implementations must honor the signal; accepting and ignoring it is a defect (the mock rejects on an aborted signal for exactly this reason). `limits()` takes no signal — discovery is quick and isn't wrapped by any caller timeout.

### InferenceLimits / limits()

```typescript
interface InferenceLimits {
  contextTokens: number;         // context window in tokens
  maxOutputTokens: number;       // max output tokens per generation
  outputTokensPerHour?: number;  // provider's worst-case output-rate model,
                                 // when it publishes one (Anthropic: 128_000)
}
```

`limits()` publishes the provider's **actual** ceilings for the configured model, discovered from the provider itself — never hand-maintained constants. Semantics differ by provider shape:

- **Anthropic** (separate ceilings): `contextTokens` = maximum *input* tokens, `maxOutputTokens` = the output ceiling — both from the Models API (`models.retrieve`).
- **Ollama** (shared window): input and output draw from one window, published as both fields — so `maxOutputTokens === contextTokens` signals a shared window to budget-derivation consumers.

`outputTokensPerHour` is the one **duration** statement a provider surface makes: Anthropic's SDK projects a call's maximum duration as `max_tokens / rate` (the `calculateNonstreamingTimeout` constant, 128K/hour) and detection derives its duration-safe output budget from it. Absent for providers whose rates are unknowable a priori (Ollama — local hardware) — and absence does **not** mean no duration bound: the detection consumer applies its own conservative assumed floor rate instead, because an unbounded output budget turned model repetition loops into hour-long transient burns. Note the modeled rate is a ceiling estimate, not a floor: generation measured live at roughly half that rate (2026-09-02), which is why consumers spend only part of their call bound against it.

Discovery is lazy (first call) and cached for the client's lifetime; a failed discovery is **not** cached, so the next call retries. `limits()` **throws** when the ceilings cannot be determined (unknown model, discovery endpoint unreachable) — fail-loud, never a guessed floor.

### StructuredResponse / generateStructured

```typescript
type ElementSchema = Record<string, unknown>;  // raw JSON Schema for ONE array element

interface StructuredResponse<T> {
  items: T[];
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
  usage?: TokenUsage;
}
```

`generateStructured` returns **parsed elements** — the JSON guarantee lives in the return type, not in a comment. There is no representable value meaning "here is some text I could not read": an implementation that cannot deliver the array **throws a typed `StructuredReadError`** (message `Structured response could not be read: …`, one class across all three implementations) carrying the provider's `stopReason` — because the cause classifies differently downstream: `max_tokens` means the JSON was cut off by the output budget (a retry of the same request truncates the same way — deterministic), anything else is model misbehavior a retry may fix. It is never coerced to `[]`: empty (`{ items: [] }`) is a legitimate, distinct outcome and is never conflated with a read failure — the conflation is precisely what silently discarded 202 real entities as a green empty job (STRUCTURED-INFERENCE).

Provider mechanisms:

- **Ollama** uses grammar-constrained sampling: the request's `format` field carries `{ type: 'array', items: <elementSchema> }`, so generation itself is constrained. The response text is parsed here; a non-array parse throws.
- **Anthropic** uses response-level structured output: `output_config.format` carries `{ type: 'array', items: <elementSchema> }` (array roots accepted on both live-config models — `.plans/spikes/output-config-array-root.md`), so the response **text is the schema-conforming JSON** and is parsed here. There is no tool-input accumulation step left for the SDK to hand over unparsed — the class of failure that discarded 202 entities is structurally gone; an unparseable or non-array response still throws, never coerces to `[]`. A capability gate refuses, before any request, when the Models API does not report `capabilities.structured_outputs.supported: true` — the error names the model and the `inference.model` TOML key that pins it.

`T` is a **caller assertion, not a runtime guarantee** — nothing verifies the element schema and `T` agree, and the type parameter is erased. Declare the schema and `T` adjacently at the call site, and keep per-element structural guards on the consuming side.

Truncation surfaces on two paths, and consumers must handle both: a truncated response that still parses carries a valid partial array with `stopReason: 'max_tokens'` (gate on the stop reason before consuming `items`); one cut off mid-JSON throws `StructuredReadError` with `stopReason: 'max_tokens'`. Either way the stop reason names the cause.

## AnthropicInferenceClient

```typescript
import { AnthropicInferenceClient } from '@semiont/inference';

const client = new AnthropicInferenceClient(
  process.env['ANTHROPIC_API_KEY']!,  // apiKey
  'claude-sonnet-4-6',                // model
  undefined,                          // baseURL? (default: https://api.anthropic.com)
  logger                              // logger?
);

const response = await client.generateTextWithMetadata('Hello', 100, 0.7);
```

Uses `@anthropic-ai/sdk`'s Messages API. Throws if the response contains no text content block (plain mode) or no `tool_use` block (JSON mode). SDK errors (rate limits, auth, network) propagate unchanged.

Declared capabilities: `maxConcurrency: 4` (a hosted API whose per-account rate limit sits far above one job's usage — independent calls genuinely parallelize) and `verifyDetectionYield: true`.

`limits()` discovers ceilings via the Models API (`models.retrieve(modelId)` → `max_input_tokens` / `max_tokens`); throws if either is absent. Requests whose `maxTokens` exceeds the SDK's non-streaming ceiling (≈21,333 output tokens — beyond it the SDK refuses non-streaming calls as likely to outlive its 10-minute timeout) are **streamed internally** and assembled via `finalMessage()`: same request shape, same response handling, no interface change.

## OllamaInferenceClient

```typescript
import { OllamaInferenceClient } from '@semiont/inference';

const client = new OllamaInferenceClient(
  'gemma2:9b',                // model
  'http://localhost:11434',   // baseURL? (this is the default)
  logger                      // logger?
);

const response = await client.generateTextWithMetadata('Hello', 100, 0.7);
```

Uses Ollama's native HTTP API (`POST /api/generate`, non-streaming, thinking disabled) via `fetch` — no SDK dependency. `maxTokens` maps to `num_predict`. Any model available via `ollama pull` works.

Declared capabilities: `maxConcurrency: 1` (a local single model is hardware-bound — concurrent requests queue or split one GPU for no aggregate gain, while each live context costs KV-cache memory) and `verifyDetectionYield: true` (where silent yield collapse was measured).

**Transport:** generate requests run on a per-request undici@7 dispatcher with header/body timeouts disabled — with `stream: false` Ollama sends no headers until generation completes, and Node's default fetch would otherwise kill any call generating longer than ~5 minutes. The caller's `AbortSignal` is the one bound. The `undici@^7` pin is load-bearing (the built-in fetch rejects an undici@8 Agent) and test-gated.

**Cloud-routed models** (`*-cloud` tags): `think: false` is advisory — returned thinking is surfaced on the response and warned (it inflates `eval_count`, documented at the field); the structured `format` is advisory rather than grammar-enforced, with violations surfacing as `StructuredReadError`. **Empty responses** throw `StructuredReadError('response is empty', stopReason)` — a thinking-exhausted empty (`done_reason: length`) classifies as the truncation it is.

`limits()` discovers the model's context window via `POST /api/show` (the `model_info` key `<architecture>.context_length`, with a `*.context_length` fallback). The window is shared between input and output, so it is published as both `contextTokens` and `maxOutputTokens`.

**Managed `num_ctx`:** every generate request sets `num_ctx` explicitly — sized to the prompt estimate (chars/4 heuristic + slack) plus the output budget, capped at the model window. Without it, Ollama evaluates the prompt inside the model's *default* window and **silently clips** anything beyond it. A request whose prompt estimate + output budget genuinely exceed the window **throws** before reaching the model.

**Stop reason mapping:** Ollama's `done_reason` of `stop` → `end_turn`, `length` → `max_tokens`; anything else passes through (or `unknown`).

**Throws:**
- `Prompt (~N tokens) + output budget (M) exceed the '<model>' context window` before the request is sent
- `Failed to discover model limits: /api/show returned <status>` / `/api/show reports no context length` from `limits()`
- `Ollama API error (<status>): <body>` on non-2xx responses
- `Empty response from Ollama` when the response body has no text

## MockInferenceClient

Scripted test double. Returns canned responses in order, holding on the last one; records every call.

```typescript
import { MockInferenceClient } from '@semiont/inference';

const mock = new MockInferenceClient(
  ['first reply', 'second reply'],  // responses (default: ['Mock response'])
  ['end_turn', 'max_tokens'],       // stopReasons? (default: all 'end_turn')
  { contextTokens: 8192, maxOutputTokens: 8192 }  // limits? (default: 1M/1M — generous)
);

await mock.generateText('hi', 100, 0);
mock.calls[0];          // { prompt: 'hi', maxTokens: 100, temperature: 0, options? }

mock.reset();           // clear calls, rewind to first response
mock.setResponses(['new reply']); // replace the script
```

## Observability

Every generation (success or failure) records a metric through `@semiont/observability`'s `recordInferenceUsage`:

- `provider` and `model`
- `durationMs` (wall clock)
- `outcome`: `'success'` or `'error'`
- `inputTokens` / `outputTokens` when the provider reports them (Anthropic `usage`; Ollama `prompt_eval_count` / `eval_count`)

## Error Handling

There are no custom error classes. Provider/SDK errors propagate unchanged; the only errors originated by this package are the factory config errors and the response-shape errors listed per implementation above. Retry policy is the caller's responsibility.
