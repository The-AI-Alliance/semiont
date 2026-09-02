import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK so we can assert the exact request shape and feed
// canned responses. `vi.hoisted` makes the mocks available inside the
// (hoisted) mock factory.
const { createMock, retrieveMock, streamMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  retrieveMock: vi.fn(),
  streamMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock, stream: streamMock };
    models = { retrieve: retrieveMock };
  },
}));

import { AnthropicInferenceClient } from '../implementations/anthropic.js';

/** Minimal element schema for tests — the shape callers declare. */
const TEST_ELEMENT = { type: 'object', properties: { exact: { type: 'string' } }, required: ['exact'], additionalProperties: false };

/** Models API answer for a strict-capable model — the capability gate's happy path. */
const CAPABLE_MODEL = {
  max_input_tokens: 200_000,
  max_tokens: 64_000,
  capabilities: { structured_outputs: { supported: true } },
};

describe('AnthropicInferenceClient - structured generation is output_config, not tools or prefill', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
    retrieveMock.mockResolvedValue(CAPABLE_MODEL);
  });

  it('requests response-level structured output (no tools, no assistant prefill)', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '[{"exact":"Paris"}]' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const res = await client.generateStructured('Extract locations', 1000, 0, TEST_ELEMENT);

    const req = createMock.mock.calls[0][0];

    // The constraint is response-level — no tool scaffolding (Phase 5
    // deleted the emit_json_array workaround), and the schema root is the
    // ARRAY itself: no items wrapper, no unwrap.
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.output_config.format.schema).toEqual({ type: 'array', items: TEST_ELEMENT });

    // No prefill: the request must not carry an assistant turn.
    expect(req.messages.some((m: { role: string }) => m.role === 'assistant')).toBe(false);

    // The result is the parsed array itself — no string round-trip.
    expect(res.items).toEqual([{ exact: 'Paris' }]);
  });

  it('round-trips an entity whose `exact` span contains a quote', async () => {
    // The variant-2 failure: an unescaped `"` inside a verbatim span.
    // Schema-enforced output serializes properly-escaped JSON, so it
    // round-trips cleanly.
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([{ exact: 'the "best" café', prefix: 'a' }]) }],
      stop_reason: 'end_turn',
      usage: {},
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const res = await client.generateStructured<{ exact: string }>('p', 1000, 0, TEST_ELEMENT);

    expect(res.items[0].exact).toBe('the "best" café');
  });

  it('preserves the real stop_reason and yields an empty array for an empty extraction', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '[]' }],
      stop_reason: 'end_turn',
      usage: {},
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const res = await client.generateStructured('p', 1000, 0, TEST_ELEMENT);

    expect(res.stopReason).toBe('end_turn');
    expect(res.items).toEqual([]);
  });
});

describe('AnthropicInferenceClient - plain text mode unchanged', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
  });

  it('returns the text block and offers no tools when format is unset', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'hello world' }],
      stop_reason: 'end_turn',
      usage: {},
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const text = await client.generateText('p', 100, 0);

    expect(text).toBe('hello world');
    const req = createMock.mock.calls[0][0];
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
  });
});

describe('AnthropicInferenceClient - cancellation threads to the SDK (ABANDONED-INFERENCE P1)', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
    retrieveMock.mockResolvedValue(CAPABLE_MODEL);
  });

  it('forwards the AbortSignal into the SDK request options (create path)', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {},
    });
    const controller = new AbortController();

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    await client.generateText('p', 100, 0, controller.signal);

    // The SDK aborts the live attempt AND checks the signal between its own
    // internal retries — forwarding it is what turns our timeout from an
    // abandonment into a cancellation.
    const opts = createMock.mock.calls[0][1] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBe(controller.signal);
  });

  it('forwards the AbortSignal on the structured path too', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '[]' }],
      stop_reason: 'end_turn',
      usage: {},
    });
    const controller = new AbortController();

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    await client.generateStructured('p', 100, 0, TEST_ELEMENT, controller.signal);

    const opts = createMock.mock.calls[0][1] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBe(controller.signal);
  });

  it('forwards the AbortSignal on the internal-streaming path (large budgets)', async () => {
    streamMock.mockReturnValue({
      finalMessage: async () => ({
        content: [{ type: 'text', text: '[]' }],
        stop_reason: 'end_turn',
        usage: {},
      }),
    });
    const controller = new AbortController();

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    await client.generateStructured('p', 64_000, 0, TEST_ELEMENT, controller.signal);

    const opts = streamMock.mock.calls[0][1] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBe(controller.signal);
  });
});

describe('AnthropicInferenceClient - limits() discovery', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
  });

  it('discovers context/output ceilings from the Models API and caches the result', async () => {
    retrieveMock.mockResolvedValue({ max_input_tokens: 200_000, max_tokens: 64_000 });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    expect(await client.limits()).toEqual({ contextTokens: 200_000, maxOutputTokens: 64_000 });
    expect(await client.limits()).toEqual({ contextTokens: 200_000, maxOutputTokens: 64_000 });

    // Discovered once, cached across calls.
    expect(retrieveMock).toHaveBeenCalledTimes(1);
    expect(retrieveMock).toHaveBeenCalledWith('claude-x');
  });

  it('throws on discovery failure and does not cache the failure', async () => {
    retrieveMock.mockRejectedValueOnce(new Error('404: model not found'));

    const client = new AnthropicInferenceClient('test-key', 'claude-unknown');
    await expect(client.limits()).rejects.toThrow(/limits/i);

    // A later call retries instead of replaying the cached rejection.
    retrieveMock.mockResolvedValueOnce({ max_input_tokens: 1000, max_tokens: 100 });
    expect(await client.limits()).toEqual({ contextTokens: 1000, maxOutputTokens: 100 });
    expect(retrieveMock).toHaveBeenCalledTimes(2);
  });

  it('throws when the Models API omits the ceilings', async () => {
    retrieveMock.mockResolvedValue({ max_input_tokens: null, max_tokens: null });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    await expect(client.limits()).rejects.toThrow(/ceiling/i);
  });
});

describe('AnthropicInferenceClient - large output budgets stream internally', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
    retrieveMock.mockResolvedValue(CAPABLE_MODEL);
  });

  it('streams above the SDK non-streaming ceiling (structured mode end-to-end)', async () => {
    // The SDK refuses non-streaming create() above ~21,333 output tokens
    // (its projected duration exceeds the 10-minute timeout). A derived
    // 64K budget must therefore stream internally — same interface, same
    // response handling.
    streamMock.mockReturnValue({
      finalMessage: async () => ({
        content: [{ type: 'text', text: '[{"exact":"A"}]' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const res = await client.generateStructured('p', 64_000, 0, TEST_ELEMENT);

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();

    // output_config rides the streamed request unchanged (the SDK's stream
    // examples carry it natively).
    const req = streamMock.mock.calls[0][0];
    expect(req.max_tokens).toBe(64_000);
    expect(req.output_config.format.schema).toEqual({ type: 'array', items: TEST_ELEMENT });

    // And the response is processed identically (parsed items).
    expect(res.items).toEqual([{ exact: 'A' }]);
  });

  it('keeps plain create() below the ceiling', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'small' }],
      stop_reason: 'end_turn',
      usage: {},
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const text = await client.generateText('p', 1000, 0);

    expect(text).toBe('small');
    expect(streamMock).not.toHaveBeenCalled();
  });
});
