/**
 * STRUCTURED-INFERENCE — pin the read-failure contract (Phases 1–3, 5).
 *
 * The original defect: the JSON-mode unwrap collapsed "we could not read the
 * model" into "the model found nothing" (`Array.isArray(items) ? items : []`)
 * — 202 real entities discarded as a green empty job when one unescaped OCR
 * backslash broke the SDK's tool-input parse.
 *
 * `generateStructured` makes unreadable a THROW, distinct from empty, and
 * Phase 5 removed the tool-input accumulation step entirely: structured
 * output now rides `output_config.format` with an ARRAY root (spike
 * 2026-08-06), so the response text IS the JSON and the read path is
 * parse-and-verify. These tests pin the contract across that mechanism:
 * unreadable → throw ("could not be read"); empty → `{ items: [] }`;
 * incapable model → config-actionable refusal before any request.
 *
 * (History: written as Phase 1's declared RED against the tool-use
 * mechanism; fixtures moved from tool_use blocks to text blocks when Phase 5
 * deleted the tool. The assertions never changed.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

/** One array element's JSON Schema — the caller-supplied shape. */
const PERSON_ELEMENT: Record<string, unknown> = {
  type: 'object',
  properties: {
    exact: { type: 'string' },
    entityType: { type: 'string' },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
  },
  required: ['exact', 'entityType'],
  additionalProperties: false,
};

/** A Models API answer for a strict-capable model (the live-config shape). */
const CAPABLE_MODEL = {
  max_input_tokens: 200_000,
  max_tokens: 64_000,
  capabilities: { structured_outputs: { supported: true } },
};

/** A structured response is a TEXT block whose text is the JSON. */
const textResponse = (text: string, stopReason = 'end_turn') => ({
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe('AnthropicInferenceClient.generateStructured — unreadable is a throw, never []', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
    // The capability gate consults the Models API before any structured
    // request; default to a capable model so these tests stay about the
    // read path.
    retrieveMock.mockResolvedValue(CAPABLE_MODEL);
  });

  it('throws when the response text is not valid JSON (the invalid-escape shape, shrunk)', async () => {
    // The live payload's head: an OCR backslash the serializer failed to
    // escape, truncated mid-stream. Under the old unwrap this class of
    // unreadable payload became "[]" + job:complete.
    createMock.mockResolvedValue(
      textResponse('[{"exact":"\\Villiam Crookes","entityType":"Person"},{"exact":"'),
    );

    const client = new AnthropicInferenceClient('test-key', 'claude-x');

    await expect(
      client.generateStructured('p', 1000, 0.3, PERSON_ELEMENT),
    ).rejects.toThrow(/could not be read/i);
  });

  it('throws when the response parses but is not an array', async () => {
    createMock.mockResolvedValue(textResponse('{"entities": []}'));

    const client = new AnthropicInferenceClient('test-key', 'claude-x');

    await expect(
      client.generateStructured('p', 1000, 0.3, PERSON_ELEMENT),
    ).rejects.toThrow(/could not be read/i);
  });

  it('returns { items: [] } for a well-formed empty array — empty survives as a distinct outcome', async () => {
    // The test that keeps the fix honest: "the model found nothing" is a
    // legitimate success and must NOT become a throw.
    createMock.mockResolvedValue(textResponse('[]'));

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const response = await client.generateStructured('p', 1000, 0.3, PERSON_ELEMENT);

    expect(response.items).toEqual([]);
    expect(response.stopReason).toBe('end_turn');
  });
});

describe('AnthropicInferenceClient.generateStructured — output_config + capability gate', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
  });

  it('refuses, before any request is issued, when the model does not support structured outputs', async () => {
    // D4: no silent degradation. Unconstrained generation IS the behaviour
    // that turned 202 entities into a green empty job — a model that cannot
    // honour the schema gets a loud, config-actionable error, not a quiet
    // fallback.
    retrieveMock.mockResolvedValue({
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      capabilities: { structured_outputs: { supported: false } },
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-legacy');
    await expect(
      client.generateStructured('p', 1000, 0.3, PERSON_ELEMENT),
    ).rejects.toThrow(/structured outputs.*inference\.model|inference\.model.*structured outputs/is);

    // The refusal happens at the gate — the model is never asked.
    expect(createMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('sends response-level structured output: an array-root schema, no tools, no prefill', async () => {
    retrieveMock.mockResolvedValue(CAPABLE_MODEL);
    createMock.mockResolvedValue(textResponse('[]'));

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    await client.generateStructured('p', 1000, 0.3, PERSON_ELEMENT);

    const req = createMock.mock.calls[0][0];
    // The constraint is response-level: no tool scaffolding at all.
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    // The schema is the caller's element schema under an ARRAY root — the
    // spike-established shape that made the items wrapper deletable.
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.output_config.format.schema).toEqual({ type: 'array', items: PERSON_ELEMENT });
    // No prefill: the request must not carry an assistant turn.
    expect(req.messages.some((m: { role: string }) => m.role === 'assistant')).toBe(false);
  });
});
