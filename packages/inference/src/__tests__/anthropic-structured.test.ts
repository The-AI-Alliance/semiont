/**
 * STRUCTURED-INFERENCE Phase 1 — pin the lie (declared RED).
 *
 * The Anthropic client's JSON mode collapses "we could not read the model"
 * into "the model found nothing": when the SDK cannot parse the accumulated
 * tool input (live case: one unescaped OCR backslash among 1,156 escapes in a
 * 67,553-char `items` payload), `input.items` arrives as a STRING, and
 * `Array.isArray(items) ? items : []` returns `"[]"` with a green stopReason.
 * 202 real entities were discarded and reported as success.
 *
 * These tests specify the replacement surface, `generateStructured`:
 * unreadable input THROWS (distinct from empty), and a genuinely empty
 * extraction survives as `{ items: [] }` — never conflated.
 *
 * Written as Phase 1's declared RED (all three failed with
 * `generateStructured is not a function` against pre-Phase-2 HEAD, with the
 * pinned "could not be read" semantics unmatchable by that TypeError);
 * Phase 2 made them green and deleted the interim structural bridge these
 * tests carried.
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

/** One array element's JSON Schema — the caller-supplied shape (Phase 2/3). */
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

describe('AnthropicInferenceClient.generateStructured — unreadable is a throw, never []', () => {
  beforeEach(() => {
    createMock.mockReset();
    retrieveMock.mockReset();
    streamMock.mockReset();
  });

  it('throws when the SDK delivers items as a string (the observed 67K-char shape, shrunk)', async () => {
    // What the SDK hands over when tool-input JSON fails to parse: the raw
    // accumulated text as a string — here the live payload's head, with the
    // OCR backslash that broke escaping.
    createMock.mockResolvedValue({
      content: [{
        type: 'tool_use', id: 't', name: 'emit_json_array',
        input: { items: '[{"exact":"\\Villiam Crookes","entityType":"Person"},{"exact":"' },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12656, output_tokens: 20948 },
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const call = async () => client.generateStructured('p', 1000, 0.3, PERSON_ELEMENT);

    // Today this shape produces "[]" + job:complete. It must be a loud read
    // failure, distinguishable from an empty extraction.
    await expect(call()).rejects.toThrow(/could not be read/i);
  });

  it('throws when input is present but items is absent', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'emit_json_array', input: {} }],
      stop_reason: 'tool_use',
      usage: {},
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const call = async () => client.generateStructured('p', 1000, 0.3, PERSON_ELEMENT);

    await expect(call()).rejects.toThrow(/could not be read/i);
  });

  it('returns { items: [] } for a well-formed empty array — empty survives as a distinct outcome', async () => {
    // The test that keeps the fix honest: "the model found nothing" is a
    // legitimate success and must NOT become a throw.
    createMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'emit_json_array', input: { items: [] } }],
      stop_reason: 'tool_use',
      usage: {},
    });

    const client = new AnthropicInferenceClient('test-key', 'claude-x');
    const response = await client.generateStructured('p', 1000, 0.3, PERSON_ELEMENT);

    expect(response.items).toEqual([]);
    expect(response.stopReason).toBe('tool_use');
  });
});
