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

describe('AnthropicInferenceClient - JSON mode is tool-use, not prefill', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
  });

  it('forces a schema-typed tool call (no assistant prefill) for { format: "json" }', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit', input: { items: [{ exact: 'Paris' }] } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const text = await client.generateText('Extract locations', 1000, 0, { format: 'json' });

    const req = createMock.mock.calls[0][0];

    // A single tool is offered and the model is forced to call exactly it.
    expect(Array.isArray(req.tools)).toBe(true);
    expect(req.tools).toHaveLength(1);
    expect(req.tool_choice).toMatchObject({ type: 'tool' });
    expect(req.tool_choice.name).toBe(req.tools[0].name);

    // The tool input is a schema-typed object wrapping an array (tool inputs
    // must be objects); the array lives under `items`.
    expect(req.tools[0].input_schema.type).toBe('object');
    expect(req.tools[0].input_schema.properties.items.type).toBe('array');

    // No prefill: the request must not carry an assistant turn.
    expect(req.messages.some((m: { role: string }) => m.role === 'assistant')).toBe(false);

    // The returned text is a parseable top-level JSON ARRAY (the array is
    // re-serialized out of the tool_use input wrapper).
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([{ exact: 'Paris' }]);
  });

  it('round-trips an entity whose `exact` span contains a quote', async () => {
    // The variant-2 failure: an unescaped `"` inside a verbatim span. Tool-use
    // makes the API serialize properly-escaped JSON, so it round-trips cleanly.
    createMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'emit', input: { items: [{ exact: 'the "best" café', prefix: 'a' }] } }],
      stop_reason: 'tool_use',
      usage: {},
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const text = await client.generateText('p', 1000, 0, { format: 'json' });

    const parsed = JSON.parse(text);
    expect(parsed[0].exact).toBe('the "best" café');
  });

  it('preserves the real stop_reason and yields an empty array for an empty extraction', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'emit', input: { items: [] } }],
      stop_reason: 'tool_use',
      usage: {},
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const res = await client.generateTextWithMetadata('p', 1000, 0, { format: 'json' });

    expect(res.stopReason).toBe('tool_use');
    expect(JSON.parse(res.text)).toEqual([]);
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
  });

  it('streams above the SDK non-streaming ceiling (json mode end-to-end)', async () => {
    // The SDK refuses non-streaming create() above ~21,333 output tokens
    // (its projected duration exceeds the 10-minute timeout). A derived
    // 64K budget must therefore stream internally — same interface, same
    // response handling.
    streamMock.mockReturnValue({
      finalMessage: async () => ({
        content: [{ type: 'tool_use', id: 't', name: 'emit', input: { items: [{ exact: 'A' }] } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const res = await client.generateTextWithMetadata('p', 64_000, 0, { format: 'json' });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();

    // Forced tool-use rides the streamed request unchanged.
    const req = streamMock.mock.calls[0][0];
    expect(req.max_tokens).toBe(64_000);
    expect(req.tool_choice).toMatchObject({ type: 'tool' });

    // And the response is processed identically (unwrapped top-level array).
    expect(JSON.parse(res.text)).toEqual([{ exact: 'A' }]);
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
