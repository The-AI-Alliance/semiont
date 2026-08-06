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

  limits(): Promise<InferenceLimits>;

  generateText(
    prompt: string,
    maxTokens: number,
    temperature: number
  ): Promise<string>;

  generateTextWithMetadata(
    prompt: string,
    maxTokens: number,
    temperature: number
  ): Promise<InferenceResponse>;

  generateStructured<T>(
    prompt: string,
    maxTokens: number,
    temperature: number,
    elementSchema: ElementSchema
  ): Promise<StructuredResponse<T>>;
}

interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}
```

`generateText` is `generateTextWithMetadata` with the metadata dropped.

### InferenceLimits / limits()

```typescript
interface InferenceLimits {
  contextTokens: number;    // context window in tokens
  maxOutputTokens: number;  // max output tokens per generation
}
```

`limits()` publishes the provider's **actual** ceilings for the configured model, discovered from the provider itself — never hand-maintained constants. Semantics differ by provider shape:

- **Anthropic** (separate ceilings): `contextTokens` = maximum *input* tokens, `maxOutputTokens` = the output ceiling — both from the Models API (`models.retrieve`).
- **Ollama** (shared window): input and output draw from one window, published as both fields — so `maxOutputTokens === contextTokens` signals a shared window to budget-derivation consumers.

Discovery is lazy (first call) and cached for the client's lifetime; a failed discovery is **not** cached, so the next call retries. `limits()` **throws** when the ceilings cannot be determined (unknown model, discovery endpoint unreachable) — fail-loud, never a guessed floor.

### StructuredResponse / generateStructured

```typescript
type ElementSchema = Record<string, unknown>;  // raw JSON Schema for ONE array element

interface StructuredResponse<T> {
  items: T[];
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}
```

`generateStructured` returns **parsed elements** — the JSON guarantee lives in the return type, not in a comment. There is no representable value meaning "here is some text I could not read": an implementation that cannot deliver the array **throws** (`Structured response could not be read: …`). Empty (`{ items: [] }`) is a legitimate, distinct outcome and is never conflated with a read failure — the conflation is precisely what silently discarded 202 real entities as a green empty job (STRUCTURED-INFERENCE).

Provider mechanisms:

- **Ollama** uses grammar-constrained sampling: the request's `format` field carries `{ type: 'array', items: <elementSchema> }`, so generation itself is constrained. The response text is parsed here; a non-array parse throws.
- **Anthropic** uses forced structured **tool-use**. The client offers a single tool and forces it via `tool_choice: { type: 'tool', name }`, so the model must answer by filling the tool's input — which the API serializes as **properly-escaped** JSON. Because a tool's input must be an object, the array is carried under an `items` property. When the SDK cannot parse the accumulated tool input (one invalid escape in a large payload), it delivers `items` as a *string* — that is a throw, never a coerced `[]`.

`T` is a **caller assertion, not a runtime guarantee** — nothing verifies the element schema and `T` agree, and the type parameter is erased. Declare the schema and `T` adjacently at the call site, and keep per-element structural guards on the consuming side.

Truncation still surfaces via `stopReason: 'max_tokens'` — a truncated structured response can carry a valid partial array, so consumers gate on the stop reason before consuming `items`.

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
