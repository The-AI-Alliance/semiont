# @semiont/inference

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+inference%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=inference)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=inference)
[![npm version](https://img.shields.io/npm/v/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/inference.svg)](https://www.npmjs.com/package/@semiont/inference)
[![License](https://img.shields.io/npm/l/@semiont/inference.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The model providers Semiont's services call, behind one interface. An `InferenceClient` generates text, or a typed list of elements, says what its model's limits are, and can be cancelled. Anthropic and Ollama implement it.

## Who uses it

Two of Semiont's services hold a model credential, and only they create clients:

- the [Worker](../../apps/worker/README.md), through [`@semiont/jobs`](../jobs/README.md): one client for each model its job types are configured with;
- the [Librarian](../../apps/librarian/README.md), through [`@semiont/make-meaning`](../make-meaning/README.md): one for the Matcher and one for the Gatherer.

**Building an application?** You do not need this package. An application asks a knowledge base to do the inference, through [`@semiont/sdk`](../sdk/README.md): `mark.assist`, `yield.fromContext`, `gather` and `match`.

## What is in it

| | |
|---|---|
| `InferenceClient` | The contract: `generateText`, `generateTextWithMetadata`, `generateStructured`, `limits()`, and the two capabilities a provider declares |
| `createInferenceClient(config, logger?)` | Picks the implementation from `config.type`. It does no I/O |
| `AnthropicInferenceClient` | Anthropic's Messages API, through its SDK |
| `OllamaInferenceClient` | Ollama's native HTTP API, with no SDK |
| `MockInferenceClient` | A scripted double for tests: canned responses in order, every call recorded |
| `StructuredReadError` | What a structured generation throws when the response cannot be read as the list that was asked for |
| `answerLimitsRequests`, `reportLimits` | How a service that holds clients answers a limits request on the bus, with each model's discovered limits |

Every generation records a usage metric through [`@semiont/observability`](../observability/README.md): provider, model, duration, outcome, and the token counts the provider reported.

The package holds no prompts, no reading of what a model answered, and no retries. Those are its callers'.

## Example

```typescript
import { createInferenceClient } from '@semiont/inference';

// Ollama needs no key, and its endpoint defaults to http://localhost:11434.
// For Anthropic: { type: 'anthropic', model, apiKey }.
const client = createInferenceClient({ type: 'ollama', model: 'gemma2:9b' });

// Asked of the provider on first use, then kept.
const { contextTokens, maxOutputTokens } = await client.limits();

// A prompt, the most tokens to generate, and the temperature.
const text = await client.generateText('Explain quantum computing in simple terms', 500, 0.7);

// A typed list, or a throw. The schema is of one element.
const { items } = await client.generateStructured<{ exact: string }>(
  'List the people named in: "Ada met Charles."',
  1000,
  0,
  { type: 'object', properties: { exact: { type: 'string' } }, required: ['exact'], additionalProperties: false },
);
```

## What a change must keep

- **Callers never ask which provider they hold.** What differs between providers is a capability the client declares: `maxConcurrency`, how many independent calls gain from running at once, and `verifyDetectionYield`, whether a detection's results are count-checked. A new provider takes a position on each.
- **Limits are asked of the provider, never kept in a table here.** `limits()` discovers the model's context window and its output ceiling. A success is cached, a failure is not, and when the limits cannot be found it throws rather than guess.
- **A structured generation returns parsed elements or throws.** A response that is unreadable, empty or cut off mid-list is a `StructuredReadError` carrying the provider's stop reason. It is never an empty list.
- **A cancelled call stops at the provider.** Every generation takes an `AbortSignal`, and aborting tears the request down rather than leaving it running and billed.
- **Token counts are the provider's own.** `usage` is absent when the provider reported none. It is never estimated.

## Adding a provider

1. Implement `InferenceClient` in [src/implementations/](src/implementations/). The interface requires both capabilities, so a provider that takes no position does not compile. [factory.test.ts](src/__tests__/factory.test.ts) pins each implementation's values: add the new one's.
2. Add its name to `InferenceClientType` and its case to `createInferenceClient`, in [src/factory.ts](src/factory.ts).
3. Admit the type in the configuration [`@semiont/core`](../core/README.md) reads: its config loader and schema name the providers too.

The callers need no change: they are written to the contract.

## Documentation

- [API reference](docs/API.md): each method, what each provider does to honour it, the mock, and the limits report.
- [Configuration](../../docs/operator/administration/CONFIGURATION.md#inference): how a knowledge base names its models.

## License

Apache-2.0
