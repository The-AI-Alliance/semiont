# @semiont/inference

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+inference%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=inference)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=inference)
[![npm version](https://img.shields.io/npm/v/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![License](https://img.shields.io/npm/l/@semiont/inference.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

**AI primitives for text generation: a provider-agnostic inference client.**

This package provides the **core AI primitives** for the Semiont platform:
- The `InferenceClient` interface (provider abstraction)
- Client implementations for Anthropic and Ollama, plus a scripted mock for tests
- A `createInferenceClient()` factory that selects the implementation from config
- Cross-provider structured generation (`generateStructured` — parsed elements or a throw, never a silent `[]`)
- Usage metrics via `@semiont/observability`

For **application-specific AI logic** (semantic processing, prompt engineering, response parsing), see [@semiont/make-meaning](../make-meaning/).

## Architecture Context

**Infrastructure Ownership**: In production, inference clients are **created by [@semiont/make-meaning](../make-meaning/)'s `startMakeMeaning()`** (one client per knowledge-system actor — Gatherer, Matcher) and by [@semiont/jobs](../jobs/)' worker process (one client per job group). Both build an `InferenceClientConfig` from their own configuration and call `createInferenceClient()`.

The API below can also be used directly for **testing, CLI tools, or standalone scripts**.

## Philosophy

This package is named `inference` rather than `ai-inference` to align with Semiont's core tenet: humans and AI agents have equal opportunity to work behind similar interfaces. The abstraction remains open for future human-agent parity.

**Package Responsibility**: AI primitives only. No application logic, no prompt engineering, no response parsing. Those belong in `@semiont/make-meaning`.

## Installation

```bash
npm install @semiont/inference
```

## Quick Start

```typescript
import { createInferenceClient } from '@semiont/inference';

// Anthropic (apiKey required)
const claude = createInferenceClient({
  type: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env['ANTHROPIC_API_KEY']!,
});

// Ollama (no API key; endpoint defaults to http://localhost:11434)
const local = createInferenceClient({
  type: 'ollama',
  model: 'gemma2:9b',
});

const text = await claude.generateText(
  'Explain quantum computing in simple terms',
  500,   // maxTokens
  0.7    // temperature
);
console.log(text);
```

## API Reference

See [docs/API.md](docs/API.md) for the full reference.

### `createInferenceClient(config, logger?): InferenceClient`

Factory ([src/factory.ts](src/factory.ts)). Selects the implementation from `config.type`:

```typescript
interface InferenceClientConfig {
  type: 'anthropic' | 'ollama';
  model: string;        // e.g. 'claude-sonnet-4-6', 'gemma2:9b'
  apiKey?: string;      // required for 'anthropic' (throws if missing/empty)
  endpoint?: string;    // provider URL; Ollama default: http://localhost:11434
  baseURL?: string;     // fallback used when endpoint is not set
}
```

The optional second argument is a `Logger` from `@semiont/core`.

### `InferenceClient`

The contract every implementation satisfies ([src/interface.ts](src/interface.ts)):

```typescript
interface InferenceClient {
  readonly type: string;     // 'anthropic' | 'ollama' | 'mock'
  readonly modelId: string;  // configured model name

  limits(): Promise<InferenceLimits>;
  generateText(prompt, maxTokens, temperature, signal?): Promise<string>;
  generateTextWithMetadata(prompt, maxTokens, temperature, signal?): Promise<InferenceResponse>;
  generateStructured<T>(prompt, maxTokens, temperature, elementSchema, signal?): Promise<StructuredResponse<T>>;
}
```

Every generation method takes a trailing optional `AbortSignal`: aborting tears down the underlying transport (and, on Anthropic, the SDK's internal retry loop) so a cancelled call rejects promptly instead of surviving as a billed background request. Implementations must honor it — accepting and ignoring the signal is a defect.

```typescript

interface InferenceLimits {
  contextTokens: number;         // context window (Anthropic: max input; Ollama: shared input+output)
  maxOutputTokens: number;       // max output per generation (Ollama mirrors the shared window here)
  outputTokensPerHour?: number;  // provider's worst-case output-rate model, when it
                                 // publishes one (Anthropic: 128_000; absent for Ollama)
}

interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}
```

### Structured generation

`generateStructured(prompt, maxTokens, temperature, elementSchema)` returns **parsed array elements**, not text — the JSON guarantee lives in the return type (`StructuredResponse<T> = { items: T[]; stopReason }`), not in a comment:

```typescript
const { items } = await client.generateStructured<Entity>(prompt, 1000, 0, {
  type: 'object',
  properties: { exact: { type: 'string' } },
  required: ['exact'],
  additionalProperties: false,
});
```

Each implementation honors the contract with its provider's mechanism:
- **Ollama**: grammar-constrained sampling — the request's `format` field carries the caller's element schema wrapped in an array schema.
- **Anthropic**: response-level structured output — `output_config.format` carries the caller's element schema under an **array root** (accepted on both live-config models; `.plans/spikes/output-config-array-root.md`), so the response text IS the schema-conforming JSON. No tools, no wrapper, no unwrap.

A response that cannot be read as an array — the SDK delivering unparsed tool input as a string, a missing array, an unhonoured grammar — **throws a typed `StructuredReadError`** carrying the provider's `stopReason`, because the cause classifies differently downstream: `max_tokens` is truncation (an identical retry truncates identically), anything else is model misbehavior a retry may fix. It is never coerced to `[]`: an empty extraction is a legitimate, distinct outcome, and conflating the two silently discards real data (STRUCTURED-INFERENCE).

Current callers all expect arrays (entity extraction, motivation detection). If an object-emitting caller appears, `generateStructured` grows a sibling, not an option — see the notes in [src/interface.ts](src/interface.ts).

### Provider limits

`limits()` publishes the provider's **actual** context/output ceilings for the configured model — discovered from the provider itself, never hand-maintained constants:

- **Anthropic**: the Models API (`models.retrieve`) — `max_input_tokens` / `max_tokens` — plus `outputTokensPerHour: 128_000`, the SDK's own worst-case rate model (the `calculateNonstreamingTimeout` constant): the one duration statement the provider surface makes, which detection's duration-safe budgets derive from.
- **Ollama**: `POST /api/show` — the model's context window. Input and output share that window, so it is published as both fields (`maxOutputTokens === contextTokens` signals a shared window). No rate is published — local hardware's rate is unknowable, so no duration bound applies.

Discovery is lazy and cached per client; a failed discovery is **not** cached — the next call retries. When ceilings cannot be determined (unknown model, endpoint unreachable), `limits()` **throws**: fail-loud, never a guessed floor.

Two request-time behaviors ride on the limits:
- **Ollama sets `num_ctx` explicitly** on every generate request — sized to the prompt estimate + output budget, capped at the model window. Without it, Ollama's model-*default* window silently clips large prompts. A request that genuinely cannot fit **throws** instead of being clipped.
- **Anthropic streams internally** above the SDK's non-streaming output ceiling (≈21K tokens) — same interface, same response shape.

### `MockInferenceClient`

A scripted test double ([src/implementations/mock.ts](src/implementations/mock.ts)): construct it with a list of canned responses, then inspect `calls` (recorded prompt/maxTokens/temperature/options per invocation). `reset()` and `setResponses()` helpers included. An optional third constructor argument injects `InferenceLimits` for chunking/budget tests; the default is generous (1M/1M) so ordinary tests never trip window guards.

```typescript
import { MockInferenceClient } from '@semiont/inference';

const mock = new MockInferenceClient(['first reply', 'second reply']);
await mock.generateText('hi', 100, 0);
expect(mock.calls[0].prompt).toBe('hi');
```

## Observability

Every generation records a usage metric through `@semiont/observability`'s `recordInferenceUsage`: provider, model, duration, outcome (`success`/`error`), and token counts when the provider reports them.

## Architecture

```
┌─────────────────────────────────────────────┐
│  @semiont/make-meaning   @semiont/jobs      │
│  (application logic)     (job workers)      │
│  - builds InferenceClientConfig             │
│  - calls createInferenceClient()            │
└──────────────────┬──────────────────────────┘
                   │ uses
┌──────────────────▼──────────────────────────┐
│      @semiont/inference                     │
│  (AI primitives only)                       │
│  - InferenceClient interface                │
│  - createInferenceClient() factory          │
│  - cross-provider JSON output mode          │
└──────────┬───────────────────┬──────────────┘
           │                   │
┌──────────▼──────────┐ ┌─────▼──────────────┐
│  AnthropicInference │ │  OllamaInference   │
│  Client             │ │  Client            │
│  (@anthropic-ai/sdk)│ │  (native HTTP API) │
└─────────────────────┘ └────────────────────┘
```

**Key Principles:**
- **@semiont/inference**: provider abstraction, text generation, output discipline
- **@semiont/make-meaning**: semantic processing, prompt engineering, response parsing
- **Clean separation**: adding a new provider only affects @semiont/inference

## Supported Providers

| Provider | Type | API Key | Models |
|----------|------|---------|--------|
| Anthropic | `anthropic` | Required | Claude family |
| Ollama | `ollama` | Not required | gemma2:9b, llama3.1:8b, mistral, etc. |

### Adding a New Provider

1. Implement `InferenceClient` interface in `src/implementations/`
2. Add type to `InferenceClientType` union in `src/factory.ts`
3. Add case in `createInferenceClient()` switch
4. Application code in `@semiont/make-meaning` requires no changes

## Dependencies

From [package.json](package.json):

- `@anthropic-ai/sdk` - Anthropic API client
- `@semiont/core` - `Logger` type
- `@semiont/observability` - usage metrics

Ollama uses native HTTP (`fetch`) with no SDK dependency.

## Testing

```bash
npm test                # Run tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

## License

Apache-2.0
