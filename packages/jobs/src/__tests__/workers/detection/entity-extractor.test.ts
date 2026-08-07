/**
 * Entity Extractor Tests
 *
 * Tests the extractEntities function which uses AI to detect entity references in text.
 * Focuses on extraction logic, offset validation, and response parsing.
 */

import { describe, it, expect, vi } from 'vitest';
import { MockInferenceClient, type InferenceClient } from '@semiont/inference';
import { extractEntities } from '../../../workers/detection/entity-extractor';

// Create mock client directly
const mockInferenceClient = new MockInferenceClient(['[]']);

const LOGGER = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: function (this: any) { return this; },
} as unknown as import('@semiont/core').Logger;

describe('extractEntities', () => {

  it('should extract entities with exact text + prefix/suffix context', async () => {
    const text = 'Alice went to Paris yesterday.';
    const mockResponse = [
      { exact: 'Alice', entityType: 'Person', prefix: '', suffix: ' went to' },
      { exact: 'Paris', entityType: 'Location', prefix: 'went to ', suffix: ' yesterday' },
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person', 'Location'], mockInferenceClient, false, LOGGER);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      exact: 'Alice',
      entityType: 'Person',
      prefix: '',
      suffix: ' went to',
    });
    expect(result[1]).toEqual({
      exact: 'Paris',
      entityType: 'Location',
      prefix: 'went to ',
      suffix: ' yesterday',
    });
  });

  it('should handle empty text', async () => {
    mockInferenceClient.setResponses(['[]']);

    const result = await extractEntities('', ['Person'], mockInferenceClient, false, LOGGER);

    expect(result).toEqual([]);
  });

  it('should handle no entities found', async () => {
    mockInferenceClient.setResponses(['[]']);

    const result = await extractEntities('The sky is blue', ['Person'], mockInferenceClient, false, LOGGER);

    expect(result).toEqual([]);
  });

  it('preserves prefix/suffix context for downstream reconciliation', async () => {
    // The extractor is offset-free; prefix/suffix carry locality context
    // for the downstream reconcileSelector to disambiguate.
    const mockResponse = [
      {
        exact: 'Alice',
        entityType: 'Person',
        prefix: 'Paris. ',
        suffix: ' loves',
      },
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities('Alice went to Paris. Alice loves Paris.', ['Person'], mockInferenceClient, false, LOGGER);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      exact: 'Alice',
      entityType: 'Person',
      prefix: 'Paris. ',
      suffix: ' loves',
    });
  });

  it('passes LLM output through verbatim — downstream reconcileSelector decides which entities survive', async () => {
    // `extractEntities` no longer filters and no longer carries offsets.
    // It returns everything the LLM emitted with the required field
    // types; the processor calls `reconcileSelector` per entity and
    // drops the ones whose `exact` isn't in the source.
    const text = 'Alice went to Paris.';
    const mockResponse = [
      { exact: 'Alice', entityType: 'Person' },
      { exact: 'Bob', entityType: 'Person' }, // Not in text — processor will drop
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person'], mockInferenceClient, false, LOGGER);

    expect(result).toHaveLength(2);
    expect(result[0].exact).toBe('Alice');
    expect(result[1].exact).toBe('Bob');
  });

  it('throws on truncation (max_tokens) instead of silently dropping annotations', async () => {
    // Phase 2a: a truncated response is data loss, not "no entities". The
    // truncation check runs BEFORE parse, so even a syntactically-valid but
    // incomplete array must fail the job loudly rather than return [].
    const text = 'Alice went to Paris.';
    const mockResponse = [
      { exact: 'Alice', entityType: 'Person', prefix: '', suffix: ' went to' },
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)], ['max_tokens']);

    await expect(
      extractEntities(text, ['Person'], mockInferenceClient, false, LOGGER),
    ).rejects.toThrow(/truncat/i);
  });

  it('should handle entity types with examples', async () => {
    const text = 'Apple released a new iPhone.';
    const mockResponse = [
      {
        exact: 'Apple',
        entityType: 'Organization',
        startOffset: 0,
        endOffset: 5
      }
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(
      text,
      [{ type: 'Organization', examples: ['Apple', 'Google', 'Microsoft'] }],
      mockInferenceClient,
      false,
      LOGGER,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      exact: 'Apple',
      entityType: 'Organization'
    });
  });

  it('should include descriptive references when enabled', async () => {
    const text = 'Marie Curie was a physicist. The Nobel laureate discovered radium.';
    const mockResponse = [
      {
        exact: 'Marie Curie',
        entityType: 'Person',
        startOffset: 0,
        endOffset: 11
      },
      {
        exact: 'The Nobel laureate',
        entityType: 'Person',
        startOffset: 29,
        endOffset: 47
      }
    ];

    mockInferenceClient.setResponses([JSON.stringify(mockResponse)]);

    const result = await extractEntities(text, ['Person'], mockInferenceClient, true, LOGGER);

    expect(result).toHaveLength(2);
    expect(result[0].exact).toBe('Marie Curie');
    expect(result[1].exact).toBe('The Nobel laureate');
  });

  it('throws on unreadable response instead of silently returning []', async () => {
    // An unreadable model response is silent data loss in disguise — it must
    // surface as a thrown error (→ job:failed) rather than an empty success.
    // The throw now originates in the structured surface itself
    // (STRUCTURED-INFERENCE Phase 2): the mock parses its queued response
    // and refuses non-arrays exactly as the real providers do.
    mockInferenceClient.setResponses(['This is not JSON']);

    await expect(
      extractEntities('Alice went to Paris.', ['Person'], mockInferenceClient, false, LOGGER),
    ).rejects.toThrow(/could not be read/i);
  });

  describe('source language', () => {
    // Entity references' bodies are entity-type identifiers, not LLM-generated
    // text — so only `sourceLanguage` is meaningful. It's wired into the
    // prompt so the LLM analyzes non-English source correctly.

    it('injects source-language guidance into the prompt when provided', async () => {
      mockInferenceClient.setResponses(['[]']);
      mockInferenceClient.reset();
      await extractEntities(
        'Marie Curie a découvert le radium.', ['Person'], mockInferenceClient,
        false, LOGGER, 'fr',
      );
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).toContain('Source text language: French');
    });

    it('omits source-language guidance when not provided', async () => {
      mockInferenceClient.setResponses(['[]']);
      mockInferenceClient.reset();
      await extractEntities('Alice went to Paris.', ['Person'], mockInferenceClient, false, LOGGER);
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).not.toContain('Source text language:');
    });

    it('falls back to the raw tag when the BCP-47 code is unknown', async () => {
      mockInferenceClient.setResponses(['[]']);
      mockInferenceClient.reset();
      await extractEntities(
        'Some text', ['Person'], mockInferenceClient,
        false, LOGGER, 'xx',
      );
      const sentPrompt = mockInferenceClient.calls[0]?.prompt ?? '';
      expect(sentPrompt).toContain('Source text language: xx');
    });
  });

  // ── Phase 3a: input chunking derived from provider limits ─────────────
  // A shared-window client (maxOutputTokens === contextTokens, the Ollama
  // shape) with a small window forces the derived chunk budget below the
  // content size, so extraction must loop chunks. Budgets come from
  // deriveDetectionBudget — no literals.
  describe('chunking (derived from provider limits)', () => {
    // ~9,000 chars of distinct paragraphs; OMEGA_MARKER sits in the last one.
    const paragraphs = Array.from({ length: 30 }, (_, k) =>
      `Paragraph ${String(k).padStart(2, '0')}: ${'filler words for bulk '.repeat(12)}PARA_${k} end.`,
    );
    const bigText = paragraphs.join('\n\n') + '\n\nFinal note: OMEGA_MARKER closes the document.';
    const SMALL_SHARED_LIMITS = { contextTokens: 2400, maxOutputTokens: 2400 };

    const entity = (exact: string) => JSON.stringify([{ exact, entityType: 'Person' }]);

    it('splits oversized content into multiple calls that together cover the whole document', async () => {
      const client = new MockInferenceClient([entity('AAA'), entity('BBB')], undefined, SMALL_SHARED_LIMITS);

      const result = await extractEntities(bigText, ['Person'], client, false, LOGGER);

      expect(client.calls.length).toBeGreaterThan(1);
      // First chunk must not carry the tail of the document…
      expect(client.calls[0].prompt).not.toContain('OMEGA_MARKER');
      // …but some chunk must — coverage reaches the end.
      expect(client.calls.some(c => c.prompt.includes('OMEGA_MARKER'))).toBe(true);
      // Output budget is derived, identical per call, and not the old literal.
      const budgets = new Set(client.calls.map(c => c.maxTokens));
      expect(budgets.size).toBe(1);
      expect(client.calls[0].maxTokens).not.toBe(4000);
      // Entities from different chunks are concatenated.
      expect(result.some(e => e.exact === 'AAA')).toBe(true);
      expect(result.some(e => e.exact === 'BBB')).toBe(true);
    });

    it('throws on max_tokens truncation of any chunk, not just the first', async () => {
      const client = new MockInferenceClient(
        [entity('AAA'), entity('BBB')],
        ['end_turn', 'max_tokens'],
        SMALL_SHARED_LIMITS,
      );

      await expect(
        extractEntities(bigText, ['Person'], client, false, LOGGER),
      ).rejects.toThrow(/truncat/i);
    });

    it('passes duplicate entities from adjacent chunks through — dedupe stays in the processor', async () => {
      const client = new MockInferenceClient([entity('Alice'), entity('Alice')], undefined, SMALL_SHARED_LIMITS);

      const result = await extractEntities(bigText, ['Person'], client, false, LOGGER);

      expect(result.filter(e => e.exact === 'Alice').length).toBeGreaterThanOrEqual(2);
    });

    it('reports progress at every chunk boundary (liveness heartbeat contract)', async () => {
      const client = new MockInferenceClient([entity('AAA')], undefined, SMALL_SHARED_LIMITS);
      const onChunk = vi.fn();

      await extractEntities(bigText, ['Person'], client, false, LOGGER, undefined, onChunk);

      const totalChunks = client.calls.length;
      expect(totalChunks).toBeGreaterThan(1);
      // A boundary sits between chunks: N chunks → N−1 boundary events, each
      // (completedChunks, totalChunks) with completedChunks increasing.
      expect(onChunk.mock.calls.length).toBe(totalChunks - 1);
      onChunk.mock.calls.forEach(([completed, total], idx) => {
        expect(completed).toBe(idx + 1);
        expect(total).toBe(totalChunks);
      });
    });

    it('fails the job when the structured read throws mid-chunk — never a short-array completion', async () => {
      // STRUCTURED-INFERENCE Phase 1 (declared RED): extraction must consume
      // the structured surface, whose mid-chunk throw aborts the job and
      // surfaces as job:fail. Against HEAD the legacy text surface is
      // consulted instead — the throw is never reached and this resolves
      // with entities, which is exactly the silent-completion hazard.
      let structuredCalls = 0;
      const client = {
        type: 'mock' as const,
        modelId: 'mock-model',
        limits: async () => SMALL_SHARED_LIMITS, // forces multiple chunks
        generateText: async () => '[]',
        // Legacy surface answers cleanly for every chunk — a rewrite that
        // still consults it completes and betrays itself here.
        generateTextWithMetadata: async () => ({ text: entity('AAA'), stopReason: 'end_turn' }),
        generateStructured: async () => {
          structuredCalls += 1;
          if (structuredCalls === 1) {
            return { items: [{ exact: 'AAA', entityType: 'Person' }], stopReason: 'end_turn' };
          }
          throw new Error('Structured response could not be read: items is not an array');
        },
      } as unknown as InferenceClient;

      await expect(
        extractEntities(bigText, ['Person'], client, false, LOGGER),
      ).rejects.toThrow(/could not be read/i);
    });

    it('makes exactly one call and no boundary reports when content fits the derived budget', async () => {
      const client = new MockInferenceClient([entity('Alice')]); // generous default limits
      const onChunk = vi.fn();

      const result = await extractEntities('Alice went to Paris.', ['Person'], client, false, LOGGER, undefined, onChunk);

      expect(client.calls.length).toBe(1);
      expect(onChunk).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });
});
