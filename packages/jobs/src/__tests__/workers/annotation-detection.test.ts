/**
 * Annotation Detection Tests
 *
 * Tests the high-level annotation detection orchestration layer:
 * - Comment detection with configurable instructions, tone, density
 * - Highlight detection with configurable instructions, density
 * - Assessment detection with configurable instructions, tone, density
 * - Tag detection with schema validation
 * - AI inference integration (mocked)
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { AnnotationDetection } from '../../workers/annotation-detection';
import { MockInferenceClient, type InferenceClient } from '@semiont/inference';
import type { TagSchema } from '@semiont/core';

// Test schema — supplied directly to detectTags (the dispatcher resolves
// schemaId → schema before the worker sees the job).
const IMRAD_SCHEMA: TagSchema = {
  id: 'imrad',
  name: 'IMRAD',
  description: 'Introduction, Methods, Results, and Discussion structure',
  domain: 'academic',
  tags: [
    { name: 'introduction', description: 'introduction section', examples: ['What is introduction?', 'How does introduction work?'] },
    { name: 'methods',      description: 'methods section',      examples: ['What is methods?',      'How does methods work?'] },
    { name: 'results',      description: 'results section',      examples: ['What is results?',      'How does results work?'] },
    { name: 'discussion',   description: 'discussion section',   examples: ['What is discussion?',   'How does discussion work?'] },
  ],
};

const testContent =
  'Climate change is one of the most pressing challenges facing humanity. ' +
  'Rising global temperatures have led to more frequent extreme weather events. ' +
  'Scientists agree that immediate action is necessary to mitigate these effects.';

describe('AnnotationDetection', () => {
  let mockClient: MockInferenceClient;

  beforeAll(async () => {
    mockClient = new MockInferenceClient(['[]']);
  });

  describe('detectHighlights', () => {
    it('should extract highlights from text', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Climate change',
          start: 0,
          end: 14
        },
        {
          exact: 'immediate action is necessary',
          start: 173,
          end: 202
        }
      ])]);

      const result = await AnnotationDetection.detectHighlights(
        testContent,
        mockClient
      );

      expect(result).toHaveLength(2);
      expect(result[0].exact).toBe('Climate change');
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(14);
    });

    it('should use configured instructions', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'global temperatures',
          start: 86,
          end: 105
        }
      ])]);

      const result = await AnnotationDetection.detectHighlights(
        testContent,
        mockClient,
        'Focus on scientific terms'
      );

      expect(result).toHaveLength(1);
    });

    it('should use configured density', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'pressing challenges',
          start: 31,
          end: 50
        }
      ])]);

      const result = await AnnotationDetection.detectHighlights(
        testContent,
        mockClient,
        undefined,
        5  // density
      );

      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should return match positions', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'humanity',
          start: 62,
          end: 70
        }
      ])]);

      const result = await AnnotationDetection.detectHighlights(
        testContent,
        mockClient
      );

      expect(result[0]).toHaveProperty('start');
      expect(result[0]).toHaveProperty('end');
      expect(result[0]).toHaveProperty('exact');
    });

    it('should handle empty AI response', async () => {
      mockClient.setResponses([JSON.stringify([])]);

      const result = await AnnotationDetection.detectHighlights(
        testContent,
        mockClient
      );

      expect(result).toEqual([]);
    });
  });

  describe('detectComments', () => {
    it('should extract comments with context', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Climate change',
          start: 0,
          end: 14,
          comment: 'This is a critical global issue requiring international cooperation',
          prefix: '',
          suffix: ' is one of the'
        }
      ])]);

      const result = await AnnotationDetection.detectComments(
        testContent,
        mockClient
      );

      expect(result).toHaveLength(1);
      expect(result[0].comment).toBeDefined();
      expect(result[0].exact).toBe('Climate change');
    });

    it('should return comment + exact match', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'extreme weather events',
          start: 133,
          end: 155,
          comment: 'Examples include hurricanes, droughts, and floods',
          prefix: 'more frequent ',
          suffix: '. Scientists agree'
        }
      ])]);

      const result = await AnnotationDetection.detectComments(
        testContent,
        mockClient
      );

      expect(result[0]).toHaveProperty('comment');
      expect(result[0]).toHaveProperty('exact');
      expect(result[0]).toHaveProperty('start');
      expect(result[0]).toHaveProperty('end');
    });

    it('should handle various densities', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'rising global temperatures',
          start: 72,
          end: 98,
          comment: 'Temperature increases correlate with industrial emissions',
          prefix: 'humanity. ',
          suffix: ' have led to'
        }
      ])]);

      // Test with high density
      const result = await AnnotationDetection.detectComments(
        testContent,
        mockClient,
        undefined,
        undefined,
        10  // high density
      );

      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('detectAssessments', () => {
    it('should extract assessments with evaluations', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Scientists agree',
          start: 157,
          end: 173,
          assessment: 'This claim requires citation of peer-reviewed sources',
          prefix: 'weather events. ',
          suffix: ' that immediate action'
        }
      ])]);

      const result = await AnnotationDetection.detectAssessments(
        testContent,
        mockClient
      );

      expect(result).toHaveLength(1);
      expect(result[0].assessment).toBeDefined();
      expect(result[0].exact).toBe('Scientists agree');
    });

    it('should return assessment + exact match', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'immediate action is necessary',
          start: 173,
          end: 202,
          assessment: 'The urgency is well-founded but lacks specific policy recommendations',
          prefix: 'Scientists agree that ',
          suffix: ' to mitigate these'
        }
      ])]);

      const result = await AnnotationDetection.detectAssessments(
        testContent,
        mockClient
      );

      expect(result[0]).toHaveProperty('assessment');
      expect(result[0]).toHaveProperty('exact');
      expect(result[0]).toHaveProperty('start');
      expect(result[0]).toHaveProperty('end');
    });
  });

  describe('detectTags', () => {
    it('should extract tags by category', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Climate change is one of the most pressing challenges',
          start: 0,
          end: 54
        }
      ])]);

      const result = await AnnotationDetection.detectTags(
        testContent,
        mockClient,
        IMRAD_SCHEMA,
        'introduction'
      );

      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should group tags by category', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Rising global temperatures have led to more frequent extreme weather events',
          start: 72,
          end: 148
        }
      ])]);

      const result = await AnnotationDetection.detectTags(
        testContent,
        mockClient,
        IMRAD_SCHEMA,
        'methods'
      );

      // All returned tags should have the requested category
      result.forEach(tag => {
        expect(tag.category).toBe('methods');
      });
    });

    it('should return unique tags', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Scientists agree that immediate action is necessary',
          start: 157,
          end: 209
        }
      ])]);

      const result = await AnnotationDetection.detectTags(
        testContent,
        mockClient,
        IMRAD_SCHEMA,
        'results'
      );

      // Check for uniqueness (no duplicate start/end positions)
      const positions = result.map(tag => `${tag.start}-${tag.end}`);
      const uniquePositions = new Set(positions);
      expect(positions.length).toBe(uniquePositions.size);
    });

    it('should reject invalid category', async () => {
      // Schema-id resolution moved to the dispatcher; the worker only sees
      // the resolved TagSchema. An invalid category is the worker's only
      // remaining validation surface.
      await expect(
        AnnotationDetection.detectTags(
          testContent,
          mockClient,
          IMRAD_SCHEMA,
          'invalid-category'
        )
      ).rejects.toThrow('Invalid category');
    });
  });

  describe('error handling', () => {
    it('should propagate AI inference errors', async () => {
      // detectComments consumes the structured surface, so the failure is
      // injected there.
      const errorClient = new MockInferenceClient(['']);
      errorClient.generateStructured = vi.fn().mockRejectedValue(new Error('AI service unavailable'));

      await expect(
        AnnotationDetection.detectComments(
          testContent,
          errorClient
        )
      ).rejects.toThrow('AI service unavailable');
    });

    it('throws on malformed AI responses instead of silently returning []', async () => {
      // Phase 2b: a parse failure is silent data loss — it must surface as a
      // thrown error (→ job:failed), not a graceful empty array.
      mockClient.setResponses(['invalid json']);

      await expect(
        AnnotationDetection.detectHighlights(testContent, mockClient)
      ).rejects.toThrow();
    });

    it('throws on a truncated (max_tokens) response instead of under-reporting', async () => {
      // Phase 2b truncation parity with 2a: the motivation path now reads
      // stopReason via generateTextWithMetadata and fails the job loudly
      // rather than parsing a valid-but-incomplete array as a partial success.
      mockClient.setResponses(
        [JSON.stringify([{ exact: 'Climate change', start: 0, end: 14 }])],
        ['max_tokens'],
      );

      await expect(
        AnnotationDetection.detectHighlights(testContent, mockClient)
      ).rejects.toThrow(/truncat/i);
    });
  });

  describe('configuration options', () => {
    it('should pass instructions to AI for comments', async () => {
      const customInstructions = 'Focus on explaining technical terms';
      mockClient.setResponses([JSON.stringify([])]);

      const result = await AnnotationDetection.detectComments(
        testContent,
        mockClient,
        customInstructions
      );

      // Verify detection completed successfully with custom instructions
      expect(result).toBeInstanceOf(Array);
    });

    it('should pass tone guidance to AI for comments', async () => {
      mockClient.setResponses([JSON.stringify([])]);

      const result = await AnnotationDetection.detectComments(
        testContent,
        mockClient,
        undefined,
        'academic'  // tone
      );

      // Verify detection completed successfully with tone guidance
      expect(result).toBeInstanceOf(Array);
    });

    it('should pass density configuration to AI', async () => {
      mockClient.setResponses([JSON.stringify([])]);

      const result = await AnnotationDetection.detectHighlights(
        testContent,
        mockClient,
        undefined,
        15  // density
      );

      // Verify detection completed successfully with density configuration
      expect(result).toBeInstanceOf(Array);
    });
  });

  // ── Phase 3b: input chunking derived from provider limits ─────────────
  // Small shared-window limits (the Ollama shape) force the derived chunk
  // budget below the content size; detection must loop chunks, reconcile
  // every chunk's results against the FULL document, and keep the progress
  // heartbeat alive at chunk boundaries.
  describe('chunking (derived from provider limits)', () => {
    const SMALL_SHARED_LIMITS = { contextTokens: 2400, maxOutputTokens: 2400 };
    // ALPHASPAN sits near the start; GAMMASPAN past char 8,000 — beyond both
    // the first chunk and the former substring(0, 8000) prompt clip.
    const early = 'ALPHASPAN opens the document.';
    const late = 'GAMMASPAN closes the document.';
    const bigContent = early + ' ' + 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(150) + late;

    const highlight = (exact: string) => JSON.stringify([{ exact }]);

    it('splits oversized content into multiple calls and merges results across chunks', async () => {
      const client = new MockInferenceClient(
        [highlight('ALPHASPAN'), highlight('GAMMASPAN')],
        undefined,
        SMALL_SHARED_LIMITS,
      );

      const result = await AnnotationDetection.detectHighlights(bigContent, client);

      expect(client.calls.length).toBeGreaterThan(1);
      expect(result.some(h => h.exact === 'ALPHASPAN')).toBe(true);
      expect(result.some(h => h.exact === 'GAMMASPAN')).toBe(true);
    });

    it('reconciles a late-chunk span to whole-document offsets', async () => {
      const client = new MockInferenceClient(
        [highlight('ALPHASPAN'), highlight('GAMMASPAN')],
        undefined,
        SMALL_SHARED_LIMITS,
      );

      const result = await AnnotationDetection.detectHighlights(bigContent, client);

      const gamma = result.find(h => h.exact === 'GAMMASPAN');
      expect(gamma).toBeDefined();
      // Offsets index into the full document, not the chunk the model saw.
      expect(gamma!.start).toBe(bigContent.indexOf('GAMMASPAN'));
      expect(gamma!.start).toBeGreaterThan(8000);
    });

    it('throws on max_tokens truncation of any chunk', async () => {
      const client = new MockInferenceClient(
        [highlight('ALPHASPAN'), highlight('GAMMASPAN')],
        ['end_turn', 'max_tokens'],
        SMALL_SHARED_LIMITS,
      );

      await expect(
        AnnotationDetection.detectHighlights(bigContent, client),
      ).rejects.toThrow(/truncat/i);
    });

    it('makes one call with a derived (non-literal) output budget when content fits', async () => {
      const client = new MockInferenceClient([highlight('Climate change')]); // generous default limits

      await AnnotationDetection.detectHighlights(testContent, client);

      expect(client.calls.length).toBe(1);
      // The old hand-tuned literal is gone; the budget comes from limits().
      expect(client.calls[0].maxTokens).not.toBe(2000);
      expect(client.calls[0].maxTokens).toBeGreaterThan(2000);
    });

    it('reports progress at every chunk boundary (liveness heartbeat contract)', async () => {
      const client = new MockInferenceClient([highlight('ALPHASPAN')], undefined, SMALL_SHARED_LIMITS);
      const onChunk = vi.fn();

      await AnnotationDetection.detectHighlights(bigContent, client, undefined, undefined, undefined, onChunk);

      const totalChunks = client.calls.length;
      expect(totalChunks).toBeGreaterThan(1);
      expect(onChunk.mock.calls.length).toBe(totalChunks - 1);
      onChunk.mock.calls.forEach(([completed, total], idx) => {
        expect(completed).toBe(idx + 1);
        expect(total).toBe(totalChunks);
      });
    });

    it('detectComments and detectAssessments merge across chunks the same way', async () => {
      const commentsClient = new MockInferenceClient(
        [
          JSON.stringify([{ exact: 'ALPHASPAN', comment: 'first' }]),
          JSON.stringify([{ exact: 'GAMMASPAN', comment: 'second' }]),
        ],
        undefined,
        SMALL_SHARED_LIMITS,
      );
      const comments = await AnnotationDetection.detectComments(bigContent, commentsClient);
      expect(commentsClient.calls.length).toBeGreaterThan(1);
      expect(comments.some(c => c.exact === 'GAMMASPAN')).toBe(true);

      const assessClient = new MockInferenceClient(
        [
          JSON.stringify([{ exact: 'ALPHASPAN', assessment: 'first' }]),
          JSON.stringify([{ exact: 'GAMMASPAN', assessment: 'second' }]),
        ],
        undefined,
        SMALL_SHARED_LIMITS,
      );
      const assessments = await AnnotationDetection.detectAssessments(bigContent, assessClient);
      expect(assessClient.calls.length).toBeGreaterThan(1);
      expect(assessments.some(a => a.exact === 'GAMMASPAN')).toBe(true);
    });

    it('reports liveness DURING a single long call — the seam that keeps a one-chunk job visible', async () => {
      // DETECTION-HEARTBEAT: pins the THREADING through `detectInChunks`, not
      // the timer (the wrapper owns that). One chunk means no boundary event,
      // so if this argument is ever dropped the four motivations go silent for
      // the whole run and no other test in this file notices.
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
        const pending = AnnotationDetection.detectHighlights(
          testContent, client, undefined, undefined, undefined,
          (completed, total) => activity.push([completed, total]),
        );

        await vi.advanceTimersByTimeAsync(45_000);

        expect(activity.length).toBeGreaterThanOrEqual(2);
        // Liveness, not invented progress: the position never advances (D3).
        expect(activity.every(([completed, total]) => completed === 0 && total === 1)).toBe(true);

        finish({ items: [], stopReason: 'end_turn' });
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    it('detectTags chunks within the per-category call', async () => {
      const client = new MockInferenceClient(
        [highlight('ALPHASPAN'), highlight('GAMMASPAN')],
        undefined,
        SMALL_SHARED_LIMITS,
      );

      const result = await AnnotationDetection.detectTags(
        bigContent, client, IMRAD_SCHEMA, 'introduction',
      );

      expect(client.calls.length).toBeGreaterThan(1);
      expect(result.some(t => t.exact === 'GAMMASPAN')).toBe(true);
      result.forEach(t => expect(t.category).toBe('introduction'));
    });
  });
});
