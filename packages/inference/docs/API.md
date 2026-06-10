# Inference API Reference

## Overview

`@semiont/inference` provides provider-agnostic text generation. The package exports exactly:

- `createInferenceClient` — factory selecting an implementation from config
- `InferenceClient`, `InferenceOptions`, `InferenceResponse` — the interface types
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

  generateText(
    prompt: string,
    maxTokens: number,
    temperature: number,
    options?: InferenceOptions
  ): Promise<string>;

  generateTextWithMetadata(
    prompt: string,
    maxTokens: number,
    temperature: number,
    options?: InferenceOptions
  ): Promise<InferenceResponse>;
}

interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}
```

`generateText` is `generateTextWithMetadata` with the metadata dropped.

### InferenceOptions

```typescript
interface InferenceOptions {
  format?: 'json';
}
```

`format: 'json'` constrains output to a **parseable top-level JSON array**, regardless of provider:

- **Ollama** uses grammar-constrained sampling: the request's `format` field carries a minimal array schema (`{ type: 'array', items: {} }`). The bare `"json"` string would allow any JSON value, including a wrapping object, which would break callers that `.map` over the result.
- **Anthropic** has no native JSON mode, so the client adds an assistant-turn prefill (`[`). Claude continues from the bracket, syntactically committed to an array. The prefill characters don't appear in the API response, so the client re-attaches the `[` before returning — callers always receive a complete JSON document.

Element shape is **not** constrained — the prompt carries the per-element schema; only the outer array is enforced.

Current callers all expect arrays (entity extraction, motivation detection). If an object-emitting caller appears, this option grows a `root: 'array' | 'object'` field; the constraint is never silently dropped.

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

Uses `@anthropic-ai/sdk`'s Messages API. Throws if the response contains no text content block. SDK errors (rate limits, auth, network) propagate unchanged.

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

**Stop reason mapping:** Ollama's `done_reason` of `stop` → `end_turn`, `length` → `max_tokens`; anything else passes through (or `unknown`).

**Throws:**
- `Ollama API error (<status>): <body>` on non-2xx responses
- `Empty response from Ollama` when the response body has no text

## MockInferenceClient

Scripted test double. Returns canned responses in order, holding on the last one; records every call.

```typescript
import { MockInferenceClient } from '@semiont/inference';

const mock = new MockInferenceClient(
  ['first reply', 'second reply'],  // responses (default: ['Mock response'])
  ['end_turn', 'max_tokens']        // stopReasons? (default: all 'end_turn')
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
