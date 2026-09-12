/**
 * Entity Extractor Tests
 *
 * Tests the extractEntities function which uses AI to detect entity references in text.
 * Focuses on extraction logic, offset validation, and response parsing.
 */

import { describe, it, expect, vi } from 'vitest';
import { MockInferenceClient, type InferenceClient } from '@semiont/inference';
import { extractEntities } from '../../../workers/detection/entity-extractor';
import { DeterministicJobError } from '../../../failure-class';

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

    // Same input truncates the same way, so the throw must carry the
    // deterministic class — a plain Error here classifies as retryable and
    // burns the retry budget re-issuing a guaranteed-to-truncate request
    // (ABANDONED-INFERENCE P3; the annotation-detection path already does
    // this and the two must not diverge).
    const pending = extractEntities(text, ['Person'], mockInferenceClient, false, LOGGER);
    await expect(pending).rejects.toThrow(/truncat/i);
    await expect(pending).rejects.toBeInstanceOf(DeterministicJobError);
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
    // Published no-op rate: these tests are about CHUNKING; a rate-silent
    // fixture would (since P3c) also enable the count-verifier, whose calls
    // would interleave into `client.calls` and muddy every assertion here.
    const SMALL_SHARED_LIMITS = { contextTokens: 2400, maxOutputTokens: 2400, outputTokensPerHour: 3_600_000_000 };

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

      const pending = extractEntities(bigText, ['Person'], client, false, LOGGER);
      await expect(pending).rejects.toThrow(/truncat/i);
      await expect(pending).rejects.toBeInstanceOf(DeterministicJobError);
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
      // A boundary sits BETWEEN chunks: N chunks → N−1 boundary events. Each
      // carries (consumedChars, totalChars) — characters, not ordinals, because
      // chunk sizing is now decided as the run goes and there is no chunk total
      // to divide by. The cursor was always the more honest numerator anyway:
      // boundary-seeking made chunks unequal long before sizing did, so
      // "chunk 3 of 10" was never 30% of the document.
      expect(onChunk.mock.calls.length).toBe(totalChunks - 1);
      let previous = 0;
      onChunk.mock.calls.forEach(([consumed, total]) => {
        expect(consumed).toBeGreaterThan(previous);
        expect(consumed).toBeLessThan(bigText.length);
        expect(total).toBe(bigText.length);
        previous = consumed;
      });
    });

    describe('chunk-grain emission', () => {
      /** Records interleaving of model calls and result emissions. */
      function tracingClient(perChunk: Array<Array<{ exact: string; entityType: string }>>) {
        const order: string[] = [];
        let call = 0;
        const client = {
          type: 'mock' as const,
          modelId: 'mock-model',
          limits: async () => SMALL_SHARED_LIMITS,
          generateText: async () => '[]',
          generateStructured: async () => {
            const i = call++;
            order.push(`infer:${i}`);
            return { items: perChunk[Math.min(i, perChunk.length - 1)] ?? [], stopReason: 'end_turn' };
          },
        } as unknown as InferenceClient;
        return { client, order };
      }

      it('emits each chunk\'s entities as that chunk completes, not once at the end', async () => {
        const { client, order } = tracingClient([
          [{ exact: 'AAA', entityType: 'Person' }],
          [{ exact: 'BBB', entityType: 'Person' }],
        ]);
        const emitted: string[][] = [];

        await extractEntities(
          bigText, ['Person'], client, false, LOGGER, undefined, undefined, undefined, undefined, undefined,
          async (items) => { order.push(`emit:${emitted.length}`); emitted.push(items.map((e) => e.exact)); },
        );

        // Only a LATER chunk can tell per-chunk emission from cumulative:
        // chunk 0's looks identical either way.
        expect(emitted.length).toBeGreaterThan(1);
        expect(emitted[0]).toEqual(['AAA']);
        expect(emitted.every((e) => e.length <= 1)).toBe(true);
        expect(emitted[1]).not.toContain('AAA');

        // The property that makes it streaming: chunk 0's results are out
        // before chunk 1's inference begins. A loop that flattened and emitted
        // at the end would order every infer before every emit.
        expect(order.indexOf('emit:0')).toBeLessThan(order.indexOf('infer:1'));
      });

      it('AWAITS the emission — a commit that fails fails the job', async () => {
        const { client } = tracingClient([[{ exact: 'AAA', entityType: 'Person' }]]);

        await expect(
          extractEntities(
            bigText, ['Person'], client, false, LOGGER, undefined, undefined, undefined, undefined, undefined,
            async () => { throw new Error('mark:commit failed: sink down'); },
          ),
        ).rejects.toThrow(/sink down/);
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

    it('reports liveness DURING a single long call — the seam that keeps a one-chunk job visible', async () => {
      // DETECTION-HEARTBEAT: this pins the THREADING, not the timer. The
      // wrapper's own heartbeat tests would still pass if `extractEntities`
      // stopped forwarding one — and a single-chunk run (every realistic
      // document) has no chunk boundary, so dropping this argument silently
      // returns detection to emitting nothing for minutes: the exact reported
      // bug, invisible to every other test in this suite.
      vi.useFakeTimers();
      try {
        let finish: (v: { items: unknown[]; stopReason: string }) => void = () => {};
        const client = {
          type: 'mock' as const,
          modelId: 'mock-model',
          limits: async () => ({ contextTokens: 1_000_000, maxOutputTokens: 1_000_000 }),
          generateText: async () => '[]',
          generateTextWithMetadata: async () => ({ text: '[]', stopReason: 'end_turn' }),
          generateStructured: () => new Promise((res) => { finish = res as typeof finish; }),
        } as unknown as InferenceClient;

        const activity: Array<[number, number]> = [];
        const content = 'Alice went to Paris.';
        // Small content → exactly one chunk → zero boundary events.
        const pending = extractEntities(
          content, ['Person'], client, false, LOGGER, undefined,
          (consumed, total) => activity.push([consumed, total]),
        );

        // Let limits()/derivation settle, then sit inside the model call.
        await vi.advanceTimersByTimeAsync(45_000);

        // Liveness arrived without any chunk boundary being crossed…
        expect(activity.length).toBeGreaterThanOrEqual(2);
        // …and it does NOT invent progress: the cursor stays put (D3). Nothing
        // has been consumed, because the one call has not returned.
        expect(activity.every(([consumed, total]) => consumed === 0 && total === content.length)).toBe(true);

        finish({ items: [], stopReason: 'end_turn' });
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    // ── adaptive sizing, end to end (DETECTION-QUALITY-THROUGHPUT P2) ──────
    //
    // The driver and the sizing rule have their own suites. What only a test
    // here can show is that THIS loop is wired to them: that a measurement
    // taken on chunk N reaches the cut of chunk N+1, through
    // `callChunkSubdividing`'s outcome and `runAdaptiveChunks`' cursor.
    describe('adaptive chunk sizing', () => {
      // Separate ceilings, so the window leaves real headroom above the 1:2
      // density guess. (The shared-window fixture above is allocated to the
      // last token by construction — nothing to grow into.)
      const HEADROOM_LIMITS = { contextTokens: 4_000, maxOutputTokens: 1_200, outputTokensPerHour: 3_600_000_000 };
      const longText = Array.from(
        { length: 900 },
        (_, i) => `Paragraph ${i} mentions Alice and Bob among some ordinary filler words.`,
      ).join(' ');

      /** Records each model call's prompt length. The scaffold is constant, so
       * differences between prompts ARE differences between chunks. */
      function sizingClient(usage?: { inputTokens: number; outputTokens: number }) {
        const promptChars: number[] = [];
        const client = {
          type: 'mock' as const,
          modelId: 'mock-model',
          limits: async () => HEADROOM_LIMITS,
          generateText: async () => '[]',
          generateStructured: async (prompt: string) => {
            promptChars.push(prompt.length);
            return { items: [], stopReason: 'end_turn', ...(usage ? { usage } : {}) };
          },
        } as unknown as InferenceClient;
        return { client, promptChars };
      }

      it('grows the chunk once measured output shows the budget going unused', async () => {
        // 60 of a 1200-token budget — 5%%, far under `growBelow`.
        const { client, promptChars } = sizingClient({ inputTokens: 400, outputTokens: 60 });

        await extractEntities(longText, ['Person'], client, false, LOGGER);

        expect(promptChars.length).toBeGreaterThan(2);
        expect(promptChars[1]!).toBeGreaterThan(promptChars[0]! * 1.2);
        expect(promptChars[2]!).toBeGreaterThan(promptChars[1]! * 1.2);
      });

      it('holds the chunk when the provider reports no usage at all', async () => {
        // `usage` is optional on the inference interface. Absent must read as
        // "nothing measured" and hold — never as "produced nothing", which is
        // 0%% utilization and would grow every chunk to the ceiling having
        // learned nothing. Against a silent provider an adaptive run is
        // indistinguishable from the static one it replaced.
        const { client, promptChars } = sizingClient();

        await extractEntities(longText, ['Person'], client, false, LOGGER);

        expect(promptChars.length).toBeGreaterThan(2);
        const steady = promptChars.slice(0, -1);
        expect(Math.max(...steady) - Math.min(...steady)).toBeLessThan(steady[0]! * 0.05);
      });

      it('eases the chunk down once measured output nears the budget', async () => {
        const { client, promptChars } = sizingClient({ inputTokens: 400, outputTokens: 1_150 });

        await extractEntities(longText, ['Person'], client, false, LOGGER);

        expect(promptChars.length).toBeGreaterThan(2);
        expect(promptChars[1]!).toBeLessThan(promptChars[0]! * 0.85);
      });
    });

    // ── resuming a unit (CHUNK-GRAIN-RESUME P3) ────────────────────────────
    describe('resuming from a checkpoint', () => {
      const RESUME_LIMITS = { contextTokens: 4_000, maxOutputTokens: 1_200, outputTokensPerHour: 3_600_000_000 };
      const opener = 'OPENING_MARKER begins the document and appears nowhere else.';
      const longText = [opener, ...Array.from(
        { length: 900 },
        (_, i) => `Paragraph ${i} mentions Alice and Bob among some ordinary filler words.`,
      )].join(' ');

      function promptRecordingClient() {
        const prompts: string[] = [];
        const client = {
          type: 'mock' as const,
          modelId: 'mock-model',
          limits: async () => RESUME_LIMITS,
          generateText: async () => '[]',
          generateStructured: async (prompt: string) => {
            prompts.push(prompt);
            return { items: [], stopReason: 'end_turn', usage: { inputTokens: 400, outputTokens: 700 } };
          },
        } as unknown as InferenceClient;
        return { client, prompts };
      }

      it('starts its first model call at the checkpoint, not the top of the document', async () => {
        // The whole point of the arc: the retry must not RE-PAY for inference
        // the dead attempt already bought. The log would dedupe the annotations
        // either way — that is not the saving being claimed here.
        const { client, prompts } = promptRecordingClient();
        const at = 30_000;

        await extractEntities(
          longText, ['Person'], client, false, LOGGER, undefined, undefined, undefined, undefined,
          { next: at, size: 600 },
        );

        expect(prompts.length).toBeGreaterThan(0);
        expect(prompts[0]).not.toContain('OPENING_MARKER');
        // And it really is at the cursor: the text there is in the first prompt.
        expect(prompts[0]).toContain(longText.slice(at, at + 40));
      });

      it('reads the whole document when there is no checkpoint', async () => {
        const { client, prompts } = promptRecordingClient();

        await extractEntities(longText, ['Person'], client, false, LOGGER);

        expect(prompts[0]).toContain('OPENING_MARKER');
      });

      it('costs no inference when the checkpoint is already at the end', async () => {
        // The unit finished its last chunk and died before it could be marked
        // complete. Re-running it must make no model call at all.
        const { client, prompts } = promptRecordingClient();

        await extractEntities(
          longText, ['Person'], client, false, LOGGER, undefined, undefined, undefined, undefined,
          { next: longText.length, size: 600 },
        );

        expect(prompts).toHaveLength(0);
      });
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

describe('temperature', () => {
  it('detection calls run at temperature 0 — a fidelity task, not a generative one', async () => {
    // Enumeration copies spans verbatim; determinism buys reproducible
    // re-runs and was measured equal to hotter settings on consistency.
    const client = new MockInferenceClient(['[]']);
    await extractEntities('Alice went to Paris.', ['Person'], client as unknown as InferenceClient, false, LOGGER);
    expect(client.calls[0]!.temperature).toBe(0);
  });
});


// ── P3c: the count-verifier (OLLAMA-DETECTION-TESTING) ────────────────────
//
// Silent yield collapse (F7): a schema-clean, stop-clean extraction returning
// a fraction of the mentions verifiably present — deterministic, so retries
// return the identical under-report, and classification-invisible, so nothing
// downstream can notice. The verifier is a cheap parallel COUNT call compared
// against the extraction's item count; the expectation comes from the same
// text, so no input assumption is made. Enabled exactly where the risk was
// measured: rate-silent providers (the same class P3b's assumed floor
// targets). A provider that publishes a rate makes NO count call.
describe('extractEntities — count-verifier (P3c)', () => {
  /** A rate-silent (Ollama-shaped) client: extraction returns `items`, the
   * count call answers `countText`. */
  function verifyingClient(items: unknown[], countText: string) {
    return {
      type: 'ollama', modelId: 'test', maxConcurrency: 1, verifyDetectionYield: true,
      limits: vi.fn(async () => ({ contextTokens: 262_144, maxOutputTokens: 262_144 })),
      generateStructured: vi.fn(async () => ({ items, stopReason: 'end_turn' })),
      generateTextWithMetadata: vi.fn(async () => ({ text: countText, stopReason: 'end_turn' })),
      generateText: vi.fn(),
    };
  }

  const TEXT = 'Alice met Bob. '.repeat(10);

  it('a healthy ratio passes untouched — and the count call was made', async () => {
    // 12 extracted vs 15 counted: 12 × 2 ≥ 15, inside the band.
    const items = Array.from({ length: 12 }, () => ({ exact: 'Alice', entityType: 'Person' }));
    const client = verifyingClient(items, '15');

    const result = await extractEntities(TEXT, ['Person'], client as never, false, LOGGER);

    expect(result).toHaveLength(12);
    expect(client.generateTextWithMetadata).toHaveBeenCalled();
  });

  it('a flagged ratio at the floor ACCEPTS the under-report loudly — unit survives (ruled 2026-09-05)', async () => {
    // 1 extracted vs 50 counted → flagged. Text this small cannot shrink, so
    // it is AT its floor on the first flag (no-shrink rule): exactly one
    // extraction, and the salvage — the entity it DID find, span-verified —
    // flows through rather than nuking ~20 good chunks with it (the P4
    // attempt-1 blast radius, ruled on 2026-09-05). Descent on genuinely
    // shrinkable chunks still discards and retries smaller.
    const items = [{ exact: 'Alice', entityType: 'Person' }];
    const client = verifyingClient(items, '50');

    const result = await extractEntities(TEXT, ['Person'], client as never, false, LOGGER);

    expect(result).toEqual([{ exact: 'Alice', entityType: 'Person' }]);
    expect(client.generateStructured.mock.calls.length).toBe(1);
  });

  it('the provider DECLARES verification — false means no count call, whatever its limits look like', async () => {
    // The old behavior keyed off rate-silence (provider-shape sniffing in
    // jobs) and exempted Anthropic. Both overruled 2026-09-05: the capability
    // is declared on the client, and every real provider declares true. False
    // remains the mock's test-ergonomics default — pinned here as the OFF
    // path.
    const items = [{ exact: 'Alice', entityType: 'Person' }];
    const client = { ...verifyingClient(items, '999'), verifyDetectionYield: false };

    const result = await extractEntities(TEXT, ['Person'], client as never, false, LOGGER);

    expect(result).toHaveLength(1);
    expect(client.generateTextWithMetadata).not.toHaveBeenCalled();
  });

  it('an Anthropic-shaped client (publishes a rate, declares true) IS verified — the 2026-09-05 ruling', async () => {
    const items = Array.from({ length: 12 }, () => ({ exact: 'Alice', entityType: 'Person' }));
    const client = verifyingClient(items, '15');
    client.limits = vi.fn(async () => ({ contextTokens: 200_000, maxOutputTokens: 64_000, outputTokensPerHour: 128_000 }));

    const result = await extractEntities(TEXT, ['Person'], client as never, false, LOGGER);

    expect(result).toHaveLength(12);
    expect(client.generateTextWithMetadata).toHaveBeenCalled();
  });

  it('a broken count call disables the verifier for that chunk — never fails a healthy extraction', async () => {
    // The verifier is a safety net; its own failure must not take the job
    // down. Unparseable count → warn and pass the extraction through.
    const items = [{ exact: 'Alice', entityType: 'Person' }];
    const client = verifyingClient(items, 'I cannot count');

    const result = await extractEntities(TEXT, ['Person'], client as never, false, LOGGER);

    expect(result).toHaveLength(1);
  });
});
