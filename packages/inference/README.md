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
- Cross-provider JSON output mode (`format: 'json'`)
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

  generateText(prompt, maxTokens, temperature, options?): Promise<string>;
  generateTextWithMetadata(prompt, maxTokens, temperature, options?): Promise<InferenceResponse>;
}

interface InferenceResponse {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | string;
}
```

### JSON output mode

Pass `{ format: 'json' }` as `options` to constrain output to a **parseable top-level JSON array**, regardless of provider:

```typescript
const json = await client.generateText(prompt, 1000, 0, { format: 'json' });
const items = JSON.parse(json); // guaranteed to be an array
```

Each implementation honors the contract with its provider's mechanism:
- **Ollama**: grammar-constrained sampling — the request's `format` field carries a minimal array schema.
- **Anthropic**: forced structured tool-use — a single tool is offered and forced via `tool_choice`, so the model answers by filling the tool's input, which the API serializes as escaped JSON. The array is carried under an `items` property (tool inputs must be objects) and unwrapped to a top-level array on return.

Current callers all expect arrays (entity extraction, motivation detection). If an object-emitting caller appears, the option grows a `root: 'array' | 'object'` field — see the notes in [src/interface.ts](src/interface.ts).

### `MockInferenceClient`

A scripted test double ([src/implementations/mock.ts](src/implementations/mock.ts)): construct it with a list of canned responses, then inspect `calls` (recorded prompt/maxTokens/temperature/options per invocation). `reset()` and `setResponses()` helpers included.

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
