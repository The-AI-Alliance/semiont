# Inference API Reference

How each part of `@semiont/inference` behaves, and what each provider does to honour the contract. The contract itself is [`src/interface.ts`](../src/interface.ts), where every member says what it promises, and the factory's configuration is [`src/factory.ts`](../src/factory.ts). What the package is for is in its [README](../README.md).

## createInferenceClient

```typescript
import { createInferenceClient, type InferenceClientConfig } from '@semiont/inference';
import type { Logger } from '@semiont/core';

const client = createInferenceClient(config, logger);
```

`config` is an `InferenceClientConfig`: a `type` (`'anthropic'` or `'ollama'`), a `model`, an `apiKey` for Anthropic, and an `endpoint` when the provider is not at its usual address. `logger` is optional.

**Throws:**
- `type: 'anthropic'` with a missing or empty `apiKey`
- an unsupported `type`

The factory is synchronous and performs no I/O; the first network call happens on the first `limits()` or generation call.

## Generating text

`generateTextWithMetadata(prompt, maxTokens, temperature, signal?)` answers the text, the reason generation stopped, and the provider's own token counts when it reported them. `generateText` is the same call with all but the text dropped.

**Cancellation** (`signal`, trailing optional on every generation method): aborting tears down the underlying transport — Ollama's `fetch`, or the Anthropic SDK request on both its paths, where the SDK also checks the signal between its internal retries — so a cancelled call rejects promptly, with the language's own `AbortError` whichever implementation it is, rather than surviving as a billed background request. Implementations must honor the signal; accepting and ignoring it is a defect (the mock rejects on an aborted signal for exactly this reason). `limits()` takes no signal — discovery is quick and isn't wrapped by any caller timeout.

## Limits

`limits()` publishes the provider's **actual** ceilings for the configured model, discovered from the provider itself — never hand-maintained constants. Semantics differ by provider shape:

- **Anthropic** (separate ceilings): `contextTokens` = maximum *input* tokens, `maxOutputTokens` = the output ceiling — both from the Models API (`models.retrieve`).
- **Ollama** (shared window): input and output draw from one window, published as both fields — so `maxOutputTokens === contextTokens` signals a shared window to budget-derivation consumers.

`outputTokensPerHour` is the one **duration** statement a provider surface makes: Anthropic's SDK projects a call's maximum duration as `max_tokens / rate` (the `calculateNonstreamingTimeout` constant, 128K/hour) and detection derives its duration-safe output budget from it. Absent for providers whose rates are unknowable a priori (Ollama — local hardware) — and absence does **not** mean no duration bound: the detection consumer applies its own conservative assumed floor rate instead, because an unbounded output budget turns a model repetition loop into an hour-long transient burn. Note the modeled rate is a ceiling estimate, not a floor: generation measured live runs at roughly half that rate, which is why consumers spend only part of their call bound against it.

Discovery is lazy (first call) and cached for the client's lifetime; a failed discovery is **not** cached, so the next call retries. `limits()` **throws** when the ceilings cannot be determined — fail-loud, never a guessed floor. A discovery the provider refused with an HTTP status (a wrong key, an unknown model, an overloaded provider) throws a `ProviderStatusError` carrying that status, whose message says what was being learned and the status; one that failed with no status (discovery endpoint unreachable, an answer that states no ceilings) throws a plain error with its cause. A generation that waits on a discovery throws the same.

## Structured generation

`generateStructured(prompt, maxTokens, temperature, elementSchema, signal?)` takes the JSON Schema of one element and answers `{ items, stopReason, usage? }`. It returns **parsed elements** — the JSON guarantee lives in the return type, not in a comment. There is no representable value meaning "here is some text I could not read": an implementation that cannot deliver the array **throws a typed `StructuredReadError`** (message `Structured response could not be read: …`, one class across all three implementations) carrying the provider's `stopReason` — because the cause classifies differently downstream: `max_tokens` means the JSON was cut off by the output budget (a retry of the same request truncates the same way — deterministic), anything else is model misbehavior a retry may fix. It is never coerced to `[]`: empty (`{ items: [] }`) is a legitimate, distinct outcome and is never conflated with a read failure — the conflation would silently discard real entities as a green empty job.

Provider mechanisms:

- **Ollama** uses grammar-constrained sampling: the request's `format` field carries `{ type: 'array', items: <elementSchema> }`, so generation itself is constrained. The response text is parsed here; a non-array parse throws.
- **Anthropic** uses response-level structured output: `output_config.format` carries `{ type: 'array', items: <elementSchema> }` (array roots accepted on both live-config models), so the response **text is the schema-conforming JSON** and is parsed here. There is no tool-input accumulation step for the SDK to hand over unparsed; an unparseable or non-array response throws, never coerces to `[]`. A capability gate refuses, before any generation is requested, when the Models API does not report `capabilities.structured_outputs.supported: true`: it throws a `StructuredUnsupportedError`, whose message names the model and the `inference.model` TOML key that pins it.

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

Uses `@anthropic-ai/sdk`'s Messages API. Throws if the response contains no text content block, on the text and the structured path alike. A refusal the SDK reports with a status is thrown as a `ProviderStatusError`, its abort as the language's `AbortError`, and an SDK error with no status (a connection that ended) propagates unchanged.

The SDK asks again, twice at the most, for a request the provider refused for the moment, and waits first as long as the refusal says: by `retry-after-ms`, or by `retry-after` in seconds or as a date. The client lets it wait two minutes at the most. A refusal that states a longer wait is thrown at once, as the `ProviderStatusError` it is, with the stated wait in its message, and the request is not made again. That is so of every request the client makes: a generation, and each of the two that discover the model's limits. The client hands the SDK a `fetch` that marks such a refusal `x-should-retry: false`, which the SDK obeys; `anthropic-retry-after.test.ts` runs the SDK itself and fails if a release stops obeying it.

Declared capabilities: `maxConcurrency: 4` (a hosted API whose per-account rate limit sits far above one job's usage — independent calls genuinely parallelize) and `verifyDetectionYield: true`.

`limits()` discovers ceilings via the Models API (`models.retrieve(modelId)` → `max_input_tokens` / `max_tokens`); throws a plain error if either is absent, and a `ProviderStatusError` if the Models API or the probe below is refused with a status. The same discovery sends one single-token request carrying a `temperature` to learn `acceptsTemperature`; for a model that refuses the parameter, the client omits it from every request. Requests whose `maxTokens` exceeds the SDK's non-streaming ceiling (≈21,333 output tokens — beyond it the SDK refuses non-streaming calls as likely to outlive its 10-minute timeout) are **streamed internally** and assembled via `finalMessage()`: same request shape, same response handling, no interface change.

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
- `ProviderStatusError` (`Failed to discover model limits: /api/show returned <status>`) from `limits()` when `/api/show` is refused, and a plain `/api/show reports no context length` when its answer states none
- `ProviderStatusError` (`Ollama API error (<status>): <body>`) on non-2xx responses to a generation
- `StructuredReadError` (`response is empty`) when the response body has no text

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
mock.calls[0];          // { prompt: 'hi', maxTokens: 100, temperature: 0, elementSchema? }

mock.reset();           // clear calls, rewind to first response
mock.setResponses(['new reply']); // replace the script
```

## The limits report

Only the services that hold a model credential can ask a provider what its model can do, so they tell everyone else. `answerLimitsRequests(bus, operation, clients, logger)` answers a limits request on the bus with the discovered `limits()` of each client it is given: the Worker on `job:limits-requested`, and the Librarian on `gather:limits-requested` and `match:limits-requested`. `reportLimits` is the report itself, for a caller with its own bus plumbing.

A report never fails and never waits on a provider. A client whose discovery is refused, or takes longer than `LIMITS_REPORT_BUDGET_MS`, is left out of that reply. Its discovery carries on, so a later request reports it.

## Observability

Every generation (success or failure) records a metric through `@semiont/observability`'s `recordInferenceUsage`:

- `provider` and `model`
- `durationMs` (wall clock)
- `outcome`: `'success'` or `'error'`
- `inputTokens` / `outputTokens` when the provider reports them (Anthropic `usage`; Ollama `prompt_eval_count` / `eval_count`)

## Error Handling

The package declares four failures, each one class for every implementation: `ProviderStatusError` (the provider refused a generation or a discovery with an HTTP status, which it carries), `StructuredUnsupportedError` (a structured generation asked of a model not known to hold a reply to a schema), `StructuredReadError` (a reply that cannot be read as what was asked for, or is empty, carrying the stop reason) and `ProviderWithheldError` (the provider withheld its answer). An abort is the language's own `AbortError`. A failure with no status, a connection that ended or a network failure, propagates as it came. The other errors this package originates are the factory config errors and the plain errors listed per implementation above. Retry policy is the caller's responsibility.
