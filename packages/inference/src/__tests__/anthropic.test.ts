import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK so we can assert the exact request shape and feed
// canned responses. `vi.hoisted` makes `createMock` available inside the
// (hoisted) mock factory.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

import { AnthropicInferenceClient } from '../implementations/anthropic.js';
import { OllamaInferenceClient } from '../implementations/ollama.js';

describe('AnthropicInferenceClient - JSON mode is tool-use, not prefill', () => {
  beforeEach(() => {
    createMock.mockReset();
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

describe('OllamaInferenceClient - grammar path unchanged (guard)', () => {
  it('sends the array-schema format for { format: "json" }', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '[]', done: true, done_reason: 'stop' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OllamaInferenceClient('llama3', 'http://localhost:11434');
    await client.generateText('p', 100, 0, { format: 'json' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.format).toEqual({ type: 'array', items: {} });

    vi.unstubAllGlobals();
  });
});
