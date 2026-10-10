// Anthropic Claude implementation of InferenceClient interface

import Anthropic, { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { isNumber, isObject, type Logger } from '@semiont/core';
import { recordInferenceUsage } from '@semiont/observability';
import { ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, ProviderStatusError, ProviderWithheldError, StructuredReadError, StructuredResponse, StructuredUnsupportedError, TokenUsage } from '../interface.js';

// The SDK's worst-case output-rate model: client.js's
// calculateNonstreamingTimeout projects a call's maximum duration as
// (60min × max_tokens) / 128_000 and refuses non-streaming create() calls
// projected past its 10-minute timeout. ONE constant, two derivations: the
// streaming switch below, and `limits().outputTokensPerHour` — the single
// duration statement this provider surface makes, which detection's
// duration budget derives from. Invalidated if the SDK revises its rate
// model: check calculateNonstreamingTimeout on SDK upgrades.
const OUTPUT_TOKENS_PER_HOUR = 128_000;

// Above ~21,333 output tokens (the 10-minute projection) we stream
// internally and assemble the final message — same request shape, same
// response handling, same interface.
const NONSTREAMING_MAX_OUTPUT_TOKENS = Math.floor(OUTPUT_TOKENS_PER_HOUR / 6);

// Structured generation rides `output_config.format` — response-level
// structured output: the response TEXT is the schema-conforming JSON, with a
// top-level ARRAY root (accepted on both live-config models). Not a forced
// tool: a tool's object-only input needs an `items` wrapper and an unwrap,
// and an unwrap that coerces an unreadable payload to `[]` leaves an
// unreadable response indistinguishable from a model that found nothing.
// With no tool-input accumulation step for the SDK to hand over unparsed,
// the read path is the same parse-and-verify shape as Ollama's.

/**
 * Everything discovery teaches us about the configured model: one Models API
 * call for ceilings and structured-output capability, plus one ~10-token
 * ACTIVE PROBE for sampling-parameter acceptance (the Models API publishes
 * no sampling capability, so acceptance is measured rather than tabled).
 * `structuredOutputsSupported` stays private to the `generateStructured`
 * gate; `temperatureAccepted` is ALSO exposed as
 * `limits().acceptsTemperature`, because it has an external consumer: the
 * UI hides the Creativity slider on rejecting models, which is what makes
 * the client-side omission honest.
 */
interface ModelDiscovery {
  limits: InferenceLimits;
  structuredOutputsSupported: boolean;
  temperatureAccepted: boolean;
}

/**
 * The probe request's output budget. Also how tests (and log readers)
 * distinguish the probe from real traffic: no production call asks for a
 * single token.
 */
const TEMPERATURE_PROBE_MAX_TOKENS = 1;

/**
 * Call-level retries, CHOSEN rather than inherited.
 *
 * Two is also SDK 0.123.0's default, and writing it down is the point: every
 * site that decides retryability either consumes a named rule from core
 * (`RETRY_RULES`) or states its own choice, and a vendor default is neither.
 * Unchosen defaults win silently. Pinned, a future SDK bump cannot change our
 * retry behavior without someone editing this line.
 *
 * Two is right here on measured grounds, not taste:
 * - **Fast failures cost almost nothing.** A 429, 409 or quick 5xx returns in
 *   seconds, so three attempts are seconds — and the SDK waits as long as a
 *   refusal says, up to the two minutes this driver lets it
 *   (`LONGEST_STATED_WAIT_MS`), which matters because entity types run
 *   concurrently, up to `maxConcurrency`, and 429 is the expected pushback.
 * - **Slow failures never reach the retries.** `boundedGenerateStructured` wraps
 *   the whole call in one 10-minute timer, and the SDK's own default timeout is
 *   also 10 minutes, so a hung call trips OUR bound during the first attempt.
 *
 * What would change it: a repeatable mid-duration 5xx — a call that generates
 * for minutes and then fails — is the one shape where these retries hurt, because
 * attempt-plus-retry can outlast our bound and surface as `InferenceTimeoutError`,
 * which `callChunkSubdividing` treats as size-shaped and answers by SUBDIVIDING.
 * Smaller chunks cannot fix a server error. Depth-capping keeps that bounded, and
 * it has not been observed; if it ever is, lower this number rather than teaching
 * the subdivider about HTTP.
 *
 * Anthropic only. Nothing here is claimed about Ollama's client.
 */
const ANTHROPIC_MAX_RETRIES = 2;

/**
 * The longest wait a refusal may state and still be waited, in milliseconds.
 *
 * The SDK waits as long as a refusal says before it asks again: by
 * `retry-after-ms`, or by `retry-after` in seconds or as a date. It has no
 * ceiling of its own on that short of weeks. This is the ceiling. A refusal
 * that states a longer wait is not waited and the request is not made again:
 * the call fails at once, by the refusal's own status, and its failure says
 * the wait the provider stated.
 *
 * Two minutes, on what a caller does around a call. A worker bounds a
 * generation, every asking of it and the waits between, at ten minutes, and
 * sizes a generation to five at the SDK's worst-case rate: two waits of two
 * minutes and a generation of five are nine of the ten. A wait that fits is
 * better waited than refused, since a job that fails is retried once at the
 * most. A wait that does not fit can only run the call into that bound,
 * which reports a timeout where the provider said "not now". And a discovery
 * is under no bound of a caller's at all.
 *
 * How it is done leans on the SDK (read at 0.131.0, client.js `shouldRetry`):
 * it obeys `x-should-retry: false` on a refusal before any rule of its own.
 * anthropic-retry-after.test.ts runs the SDK itself, and fails when a release
 * of it stops obeying that header, or stops waiting as long as a refusal
 * says.
 */
const LONGEST_STATED_WAIT_MS = 120_000;

/**
 * The header by which a refusal states a wait longer than this driver waits,
 * as the provider wrote it. Undefined where it states none, or one that is
 * waited. The wait is read as the SDK reads it (client.js `retryRequest`):
 * `retry-after-ms` first, unless it is no number or is zero, and then
 * `retry-after`, as seconds or as a date.
 */
function waitNotWaited(headers: Headers): string | undefined {
  const inMilliseconds = headers.get('retry-after-ms');
  if (inMilliseconds !== null) {
    const milliseconds = parseFloat(inMilliseconds);
    if (!Number.isNaN(milliseconds) && milliseconds !== 0) {
      return milliseconds > LONGEST_STATED_WAIT_MS ? `retry-after-ms: ${inMilliseconds}` : undefined;
    }
  }
  const stated = headers.get('retry-after');
  if (stated === null || stated === '') return undefined;
  const seconds = parseFloat(stated);
  const milliseconds = Number.isNaN(seconds) ? Date.parse(stated) - Date.now() : seconds * 1000;
  return milliseconds > LONGEST_STATED_WAIT_MS ? `retry-after: ${stated}` : undefined;
}

/**
 * The platform's `fetch`, as the SDK is handed it. A refusal that states a
 * wait longer than this driver waits is marked `x-should-retry: false`, so
 * the SDK neither waits nor asks again, and throws the refusal at once. The
 * mark replaces one the provider set: the wait decides. Every other answer
 * is passed on as it came.
 */
async function fetchStoppingAtALongWait(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok || waitNotWaited(response.headers) === undefined) return response;
  // The headers of an answer the platform fetched cannot be written, so the answer is made again around its own body.
  const headers = new Headers(response.headers);
  headers.set('x-should-retry', 'false');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export class AnthropicInferenceClient implements InferenceClient {
  readonly type = 'anthropic' as const;
  // Hosted API: a single detection job uses a sliver of the account rate limit
  // (~1 request / 72 s, zero 429s at 4 concurrent types), so independent calls
  // genuinely parallelize. Conservative: nothing above 4-way is measured.
  readonly maxConcurrency = 4;
  // Universal for real providers: "no observed collapse" here is
  // absence-of-looking, and an unexplained ~2× yield gap vs gemma on the
  // same document is exactly what verification answers. The ~2× billed
  // input is the accepted cost.
  readonly verifyDetectionYield = true;
  readonly modelId: string;
  private client: Anthropic;
  private logger?: Logger;
  private discoveryPromise?: Promise<ModelDiscovery>;

  constructor(apiKey: string, model: string, baseURL?: string, logger?: Logger) {
    this.client = new Anthropic({
      apiKey,
      baseURL: baseURL || 'https://api.anthropic.com',
      maxRetries: ANTHROPIC_MAX_RETRIES,
      fetch: fetchStoppingAtALongWait,
    });
    this.modelId = model;
    this.logger = logger;
  }

  limits(): Promise<InferenceLimits> {
    return this.discover().then(d => d.limits);
  }

  private discover(): Promise<ModelDiscovery> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = this.discoverModel().catch((err: unknown) => {
        // Never cache a failed discovery — a transient outage would otherwise
        // pin every future call to the same rejection.
        this.discoveryPromise = undefined;
        throw err;
      });
    }
    return this.discoveryPromise;
  }

  private async discoverModel(): Promise<ModelDiscovery> {
    // The Models API publishes the actual ceilings AND capabilities per
    // model — no hand-maintained table to go stale when a new model ships,
    // and the API's own metadata outranks documentation prose when the two
    // disagree (the docs' supported-model list can be stale while
    // `capabilities.structured_outputs.supported` is correct).
    const info = await this.client.models.retrieve(this.modelId).catch((err: unknown) => {
      throw discoveryFailure(`Failed to discover model limits for '${this.modelId}' from the Models API`, err);
    });
    if (info.max_input_tokens == null || info.max_tokens == null) {
      throw new Error(`Models API reports no context/output ceilings for '${this.modelId}'`);
    }
    // `capabilities` is not declared on the SDK's ModelInfo type — narrow
    // through the core guards rather than casting. Absent metadata reads as
    // unsupported: the gate then refuses loudly, never guesses.
    const raw: unknown = info;
    const structuredOutputsSupported =
      isObject(raw) &&
      isObject(raw['capabilities']) &&
      isObject(raw['capabilities']['structured_outputs']) &&
      raw['capabilities']['structured_outputs']['supported'] === true;
    const temperatureAccepted = await this.probeTemperatureAcceptance();
    return {
      limits: {
        contextTokens: info.max_input_tokens,
        maxOutputTokens: info.max_tokens,
        outputTokensPerHour: OUTPUT_TOKENS_PER_HOUR,
        acceptsTemperature: temperatureAccepted,
      },
      structuredOutputsSupported,
      temperatureAccepted,
    };
  }

  /**
   * One tiny request carrying a non-default `temperature` answers whether
   * this model accepts the parameter at all (sonnet-5 refuses every
   * non-default value on both request shapes — including the generation
   * wizard's own 0.7 default — while the Models API says nothing). Runs
   * once per model per process, cached on the same discovery record as
   * limits.
   * The 400-shape match lives HERE, on the cold path, so no production
   * request ever string-matches an error message.
   */
  private async probeTemperatureAcceptance(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.modelId,
        max_tokens: TEMPERATURE_PROBE_MAX_TOKENS,
        temperature: 0.7,
        messages: [{ role: 'user', content: 'ok' }],
      });
      return true;
    } catch (err: unknown) {
      const isTemperatureRejection =
        isObject(err) &&
        err['status'] === 400 &&
        err instanceof Error &&
        /temperature/i.test(err.message);
      if (isTemperatureRejection) {
        this.logger?.warn(
          'Model rejects `temperature`; caller-supplied values will be omitted from its requests',
          { model: this.modelId },
        );
        return false;
      }
      // Anything else is a discovery failure, not a verdict — thrown so the
      // uncached-failure rule (discover()) lets the next call retry.
      throw discoveryFailure(`Sampling-parameter probe failed for '${this.modelId}'`, err);
    }
  }

  private requestMessage(params: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal): Promise<Anthropic.Message> {
    // The signal rides the SDK's RequestOptions: an abort tears down the live
    // attempt AND is checked between the SDK's internal retries, so a
    // cancelled call cannot survive as a background zombie inside the SDK's
    // own retry/backoff loop (where one can complete 24–34 minutes
    // after abandonment). For visibility into those internal
    // retries themselves, the SDK's ANTHROPIC_LOG=debug env knob logs every
    // attempt — nothing to re-implement here.
    if (params.max_tokens > NONSTREAMING_MAX_OUTPUT_TOKENS) {
      return this.client.messages.stream(params, { signal }).finalMessage();
    }
    return this.client.messages.create(params, { signal });
  }

  async generateText(prompt: string, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<string> {
    const response = await this.generateTextWithMetadata(prompt, maxTokens, temperature, signal);
    return response.text;
  }

  async generateTextWithMetadata(prompt: string, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<InferenceResponse> {
    this.logger?.debug('Generating text with inference client', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature,
    });

    // Discovery decides whether `temperature` may ride: a rejecting model
    // 400s on ANY non-default value, and the callers keep passing one —
    // internal constants and the wire field alike — so the omission happens
    // here, once, and is visible on `limits().acceptsTemperature` rather
    // than silent.
    const { temperatureAccepted } = await this.discover();
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelId,
      max_tokens: maxTokens,
      ...(temperatureAccepted ? { temperature } : {}),
      messages: [{ role: 'user', content: prompt }],
    };

    const start = performance.now();
    const response = await this.recordedRequest(params, start, signal);

    const text = this.textOf(response, start);

    recordInferenceUsage({
      provider: this.type,
      model: this.modelId,
      durationMs: performance.now() - start,
      outcome: 'success',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    this.logger?.info('Text generation completed', {
      model: this.modelId,
      textLength: text.length,
      stopReason: response.stop_reason,
      requestId: requestIdOf(response),
    });

    return {
      text,
      stopReason: response.stop_reason || 'unknown',
      ...usageOf(response),
    };
  }

  async generateStructured<T>(
    prompt: string,
    maxTokens: number,
    temperature: number,
    elementSchema: ElementSchema,
    signal?: AbortSignal,
  ): Promise<StructuredResponse<T>> {
    // Capability gate: model choice is deployment config, so the
    // client asks the provider whether the configured model can honour
    // strictness — and REFUSES when it cannot. Silent fallback to
    // unconstrained tool use is exactly the behaviour that turns real
    // entities into a green empty job. The discovery is the same cached
    // Models API call `limits()` uses; no extra round trip.
    const discovery = await this.discover();
    if (!discovery.structuredOutputsSupported) {
      throw new StructuredUnsupportedError(
        `Model '${this.modelId}' does not report support for strict structured outputs ` +
        `(Models API capabilities.structured_outputs) — refusing rather than degrading to ` +
        `unconstrained tool use, which silently discards unreadable results. Re-point the ` +
        `inference.model key that pins this worker/actor in .semiont/semiontconfig/*.toml ` +
        `(e.g. environments.<env>.workers.<job-type>.inference.model) at a model that ` +
        `reports supported: true.`,
      );
    }

    this.logger?.debug('Generating structured output with inference client', {
      model: this.modelId,
      promptLength: prompt.length,
      maxTokens,
      temperature,
    });

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.modelId,
      max_tokens: maxTokens,
      // Same suppression as the text path: a rejecting model 400s on the
      // structured shape identically. `discovery` is the record already
      // fetched for the gate above.
      ...(discovery.temperatureAccepted ? { temperature } : {}),
      messages: [{ role: 'user', content: prompt }],
      // Response-level structured output with an ARRAY root: the response
      // text IS the schema-conforming JSON. No tools, no prefill.
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'array', items: elementSchema },
        },
      },
    };

    const start = performance.now();
    const response = await this.recordedRequest(params, start, signal);

    const text = this.textOf(response, start);

    // Anything that does not read as an array is a THROW, never a coerced
    // `[]` — "we could not read the model" must never be conflated with
    // "the model found nothing": that conflation silently discards
    // real entities as a green empty result. A truncated (`max_tokens`)
    // response surfaces here too, as unparseable JSON naming its stop_reason.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.recordError(start, response);
      this.logger?.error('Structured response could not be read', {
        model: this.modelId,
        textLength: text.length,
        stopReason: response.stop_reason,
      });
      throw new StructuredReadError('response is not valid JSON', response.stop_reason || 'unknown', { cause: err });
    }
    if (!Array.isArray(parsed)) {
      this.recordError(start, response);
      this.logger?.error('Structured response could not be read', {
        model: this.modelId,
        parsedType: typeof parsed,
        stopReason: response.stop_reason,
      });
      throw new StructuredReadError(`parsed to ${typeof parsed}, not an array`, response.stop_reason || 'unknown');
    }

    recordInferenceUsage({
      provider: this.type,
      model: this.modelId,
      durationMs: performance.now() - start,
      outcome: 'success',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    this.logger?.info('Structured generation completed', {
      model: this.modelId,
      items: parsed.length,
      stopReason: response.stop_reason,
      requestId: requestIdOf(response),
    });

    return {
      items: parsed as T[],
      stopReason: response.stop_reason || 'unknown',
      ...usageOf(response),
    };
  }

  /**
   * The answer's text, of an answer the provider gave. An answer with none, or with an empty one, is cut off
   * to nothing: a model that thinks can spend the whole output budget before
   * its first character. The stop reason rides the failure, so that
   * `max_tokens` is read as the cut-off it is.
   */
  private textOf(response: Anthropic.Message, start: number): string {
    // A refusal is asked about first: what a refused reply carries is not an
    // answer, however much of one it looks like.
    if (response.stop_reason === 'refusal') {
      this.recordError(start, response);
      const { category, explanation } = response.stop_details ?? {};
      this.logger?.error('The provider withheld its answer', { model: this.modelId, stopReason: response.stop_reason, category });
      throw new ProviderWithheldError(`refusal${category ? ` (${category})` : ''}${explanation ? `: ${explanation}` : ''}`, 'refusal');
    }
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text' || textContent.text === '') {
      this.recordError(start, response);
      this.logger?.error('Empty response from Anthropic', {
        model: this.modelId,
        stopReason: response.stop_reason,
        contentTypes: response.content.map(c => c.type),
      });
      throw new StructuredReadError('response is empty', response.stop_reason || 'unknown');
    }
    return textContent.text;
  }

  /** Issue the request, recording an error metric if the transport throws. */
  private async recordedRequest(params: Anthropic.MessageCreateParamsNonStreaming, start: number, signal?: AbortSignal): Promise<Anthropic.Message> {
    try {
      return await this.requestMessage(params, signal);
    } catch (err) {
      recordInferenceUsage({
        provider: this.type,
        model: this.modelId,
        durationMs: performance.now() - start,
        outcome: 'error',
      });
      throw generationFailure(err);
    }
  }

  private recordError(start: number, response: Anthropic.Message): void {
    recordInferenceUsage({
      provider: this.type,
      model: this.modelId,
      durationMs: performance.now() - start,
      outcome: 'error',
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });
  }
}

/**
 * A failure of the library's, as the interface states a generation's
 * failures. The library's abort is a kind of its `APIError` that carries no
 * status, so it is asked about first. A failure of the library's with no
 * status, a connection that ended for one, is passed on as it came.
 */
function generationFailure(err: unknown): unknown {
  if (err instanceof APIUserAbortError) return new DOMException('This operation was aborted', 'AbortError');
  if (err instanceof APIError && isNumber(err.status)) {
    return new ProviderStatusError(`${err.message}${statingTheWait(err)}`, err.status, { cause: err });
  }
  return err;
}

/**
 * What a refusal's failure says after the refusal itself, where the provider
 * stated a wait this driver does not wait. Otherwise nothing.
 */
function statingTheWait(refused: APIError): string {
  const said = refused.headers === undefined ? undefined : waitNotWaited(refused.headers);
  if (said === undefined) return '';
  return `; the provider said to wait (${said}), which is longer than the ${LONGEST_STATED_WAIT_MS / 1000} seconds this driver waits`;
}

/**
 * A discovery's failure, as the interface states one. `learning` says what
 * was being learned. A refusal by status carries the status, and says it,
 * with a wait the provider stated and this driver does not wait; a failure of
 * the library's with no status, a connection that ended for one, is a plain
 * error. Either has what the library threw as its cause.
 */
function discoveryFailure(learning: string, err: unknown): Error {
  if (err instanceof APIError && isNumber(err.status)) {
    return new ProviderStatusError(`${learning}: refused with status ${err.status}${statingTheWait(err)}`, err.status, { cause: err });
  }
  return new Error(learning, { cause: err });
}

/**
 * The provider's request id, for correlating our logs with Anthropic's and
 * telling one attempt from another. The SDK attaches `_request_id` to the
 * returned message at runtime but does not declare it on the `Message` type,
 * so it is read through a guard rather than a cast.
 */
function requestIdOf(response: unknown): string | undefined {
  if (isObject(response) && typeof response['_request_id'] === 'string') {
    return response['_request_id'];
  }
  return undefined;
}

/**
 * The provider's own token counts, shaped for `TokenUsage`. Absent when the
 * SDK reports none — never zero-filled: a zero would read as "this call cost
 * nothing", which is a different claim from "we do not know".
 */
function usageOf(response: { usage?: { input_tokens?: number; output_tokens?: number } }): { usage?: TokenUsage } {
  const { input_tokens, output_tokens } = response.usage ?? {};
  if (input_tokens === undefined || output_tokens === undefined) return {};
  return { usage: { inputTokens: input_tokens, outputTokens: output_tokens } };
}
