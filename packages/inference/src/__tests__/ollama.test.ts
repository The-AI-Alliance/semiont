import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaInferenceClient, unboundedTransport } from '../implementations/ollama.js';

// Ollama generate calls now consult /api/show first (limits discovery), so
// every fetch mock routes by URL: show → model metadata, generate → canned
// completion.

const SHOW_BODY = {
  model_info: {
    'general.architecture': 'llama',
    'llama.context_length': 8192,
  },
};

const GENERATE_BODY = { response: '[]', done: true, done_reason: 'stop' };

type RoutedOptions = {
  show?: { ok?: boolean; body?: unknown };
  generate?: { ok?: boolean; body?: unknown };
};

function stubRoutedFetch(options: RoutedOptions = {}) {
  const fetchMock = vi.fn(async (url: unknown) => {
    const target = String(url);
    const route = target.endsWith('/api/show') ? (options.show ?? {}) : (options.generate ?? {});
    return {
      ok: route.ok ?? true,
      status: route.ok === false ? 500 : 200,
      text: async () => 'error body',
      json: async () => route.body ?? (target.endsWith('/api/show') ? SHOW_BODY : GENERATE_BODY),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, suffix: string) {
  return fetchMock.mock.calls.filter(c => String(c[0]).endsWith(suffix));
}

function requestBody(call: unknown[]): Record<string, any> {
  const init = call[1] as { body: string };
  return JSON.parse(init.body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OllamaInferenceClient - limits() discovery', () => {
  it('discovers the model context window from /api/show and caches the result', async () => {
    const fetchMock = stubRoutedFetch();

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    const limits = await client.limits();

    // Shared window: no separate output ceiling — the window is the ceiling.
    expect(limits).toEqual({ contextTokens: 8192, maxOutputTokens: 8192 });

    await client.limits();
    const showCalls = callsTo(fetchMock, '/api/show');
    expect(showCalls).toHaveLength(1);

    // POST with the model name in the body.
    const body = requestBody(showCalls[0]);
    expect(body.model).toBe('llama3');
  });

  it('falls back to any *.context_length key when general.architecture is absent', async () => {
    stubRoutedFetch({
      show: { body: { model_info: { 'qwen2.context_length': 32768 } } },
    });

    const client = new OllamaInferenceClient('qwen2', 'http://localhost:11434');
    expect(await client.limits()).toEqual({ contextTokens: 32768, maxOutputTokens: 32768 });
  });

  it('throws when discovery fails, and does not cache the failure', async () => {
    const fetchMock = stubRoutedFetch({ show: { ok: false } });

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    await expect(client.limits()).rejects.toThrow(/limits|show/i);

    // Server recovers → a later call retries and succeeds.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => SHOW_BODY,
    }));
    expect(await client.limits()).toEqual({ contextTokens: 8192, maxOutputTokens: 8192 });
  });

  it('throws when /api/show carries no context length', async () => {
    stubRoutedFetch({ show: { body: { model_info: { 'general.architecture': 'llama' } } } });

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    await expect(client.limits()).rejects.toThrow(/context length/i);
  });
});

describe('OllamaInferenceClient - cancellation threads to the transport (ABANDONED-INFERENCE P1)', () => {
  it('passes the AbortSignal into the generate fetch', async () => {
    const fetchMock = stubRoutedFetch();
    const controller = new AbortController();

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    await client.generateText('p', 100, 0, controller.signal);

    const generateCall = callsTo(fetchMock, '/api/generate')[0];
    const init = generateCall[1] as { signal?: AbortSignal };
    expect(init.signal).toBe(controller.signal);
  });
});

describe('OllamaInferenceClient - generate owns its transport (OLLAMA-DETECTION-TESTING P3.5)', () => {
  it('sends generate through the unbounded dispatcher and leaves show on platform defaults', async () => {
    const fetchMock = stubRoutedFetch();

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    await client.generateText('p', 100, 0);

    const generateInit = callsTo(fetchMock, '/api/generate')[0][1] as { dispatcher?: unknown };
    expect(generateInit.dispatcher).toBe(unboundedTransport);

    // /api/show answers from local metadata — headers arrive immediately, so
    // the platform's default transport bound is protection there, not a
    // ceiling (limits() has no AbortSignal to be the bound instead).
    const showInit = callsTo(fetchMock, '/api/show')[0][1] as { dispatcher?: unknown };
    expect(showInit.dispatcher).toBeUndefined();
  });
});

describe('OllamaInferenceClient - managed num_ctx', () => {
  it('sets num_ctx explicitly, covering prompt estimate + output budget within the window', async () => {
    const fetchMock = stubRoutedFetch();

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    const prompt = 'x'.repeat(4000); // ≈1000 tokens at the chars/4 heuristic
    await client.generateText(prompt, 500, 0.3);

    const generateCalls = callsTo(fetchMock, '/api/generate');
    expect(generateCalls).toHaveLength(1);
    const body = requestBody(generateCalls[0]);

    // num_predict unchanged; num_ctx new — at least estimate + maxTokens
    // (today the model's default window silently clips large prompts),
    // never above the discovered window.
    expect(body.options.num_predict).toBe(500);
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(1500);
    expect(body.options.num_ctx).toBeLessThanOrEqual(8192);
  });

  it('throws (fail-loud) when prompt estimate + output budget exceed the model window', async () => {
    const fetchMock = stubRoutedFetch({
      show: { body: { model_info: { 'general.architecture': 'llama', 'llama.context_length': 2048 } } },
    });

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    const hugePrompt = 'x'.repeat(40_000); // ≈10,000 tokens ≫ 2048 window

    await expect(client.generateText(hugePrompt, 500, 0.3)).rejects.toThrow(/window|exceed/i);

    // The oversized request never reaches the model (no silent clipping).
    expect(callsTo(fetchMock, '/api/generate')).toHaveLength(0);
  });
});

describe('OllamaInferenceClient - grammar-constrained structured path', () => {
  it('sends the caller element schema wrapped in an array-schema format', async () => {
    const fetchMock = stubRoutedFetch({
      generate: { body: { response: '[{"exact":"Paris"}]', done: true, done_reason: 'stop' } },
    });
    const ELEMENT = { type: 'object', properties: { exact: { type: 'string' } }, required: ['exact'], additionalProperties: false };

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    const res = await client.generateStructured('p', 100, 0, ELEMENT);

    const body = requestBody(callsTo(fetchMock, '/api/generate')[0]);
    // Grammar-constrained sampling, now element-typed: the schema constrains
    // generation itself — strictly stronger than the old bare `items: {}`.
    expect(body.format).toEqual({ type: 'array', items: ELEMENT });
    expect(res.items).toEqual([{ exact: 'Paris' }]);
  });

  // OLLAMA-DETECTION-TESTING P1: the live gemma4:26b failure (2026-09-03) —
  // 6,858 chars of unparseable output with `done_reason` ABSENT. These pin the
  // vocabulary token at its origin: an absent done_reason maps to exactly
  // 'unknown', and that string rides the StructuredReadError downstream, where
  // classification (retryable) and subdivision (none today) key off it.
  it("maps an ABSENT done_reason to exactly 'unknown' on the thrown StructuredReadError (the live failure shape)", async () => {
    stubRoutedFetch({
      generate: { body: { response: 'entity: Cedar County ("the Society'.repeat(200), done: true } },
    });

    const client = new OllamaInferenceClient('gemma4:26b', 'http://localhost:11434');
    await expect(
      client.generateStructured('p', 100, 0, { type: 'object' }),
    ).rejects.toMatchObject({ name: 'StructuredReadError', stopReason: 'unknown' });
  });

  it("maps done_reason 'length' to 'max_tokens' on the thrown StructuredReadError (the Ollama truncation path)", async () => {
    stubRoutedFetch({
      generate: { body: { response: '[{"exact":"Par', done: true, done_reason: 'length' } },
    });

    const client = new OllamaInferenceClient('gemma4:26b', 'http://localhost:11434');
    // Downstream this exact shape classifies DETERMINISTIC and subdivides —
    // the same contract the Anthropic path carries, pinned here for Ollama.
    await expect(
      client.generateStructured('p', 100, 0, { type: 'object' }),
    ).rejects.toMatchObject({ name: 'StructuredReadError', stopReason: 'max_tokens' });
  });

  it('throws "could not be read" when the response is not a JSON array', async () => {
    stubRoutedFetch({
      generate: { body: { response: '{"entities": []}', done: true, done_reason: 'stop' } },
    });

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    await expect(
      client.generateStructured('p', 100, 0, { type: 'object' }),
    ).rejects.toThrow(/could not be read/i);
  });

  it('plain text requests carry no format constraint', async () => {
    const fetchMock = stubRoutedFetch();

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    await client.generateText('p', 100, 0);

    const body = requestBody(callsTo(fetchMock, '/api/generate')[0]);
    expect(body.format).toBeUndefined();
  });
});
