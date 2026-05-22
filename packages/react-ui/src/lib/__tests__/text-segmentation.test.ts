import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { segmentTextWithAnnotations, _resetDegradedAnchorWarnings } from '../text-segmentation';
import { getAnnotationDecorationMeta, computeAnnotationDecorations } from '../codemirror-logic';
import type { Annotation } from '@semiont/core';

// Mock api-client functions used by segmentTextWithAnnotations
vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return {
    ...actual,
  getTargetSelector: vi.fn((target: any) => {
    if (Array.isArray(target)) return target[0];
    return target;
  }),
  getTextPositionSelector: vi.fn((selector: any) => {
    if (!selector) return null;
    if (selector.type === 'TextPositionSelector') return selector;
    if (selector.selector) {
      const pos = Array.isArray(selector.selector)
        ? selector.selector.find((s: any) => s.type === 'TextPositionSelector')
        : selector.selector.type === 'TextPositionSelector' ? selector.selector : null;
      return pos ?? null;
    }
    return null;
  }),
  getTextQuoteSelector: vi.fn((selector: any) => {
    if (!selector) return null;
    if (selector.type === 'TextQuoteSelector') return selector;
    if (selector.selector) {
      const quote = Array.isArray(selector.selector)
        ? selector.selector.find((s: any) => s.type === 'TextQuoteSelector')
        : selector.selector.type === 'TextQuoteSelector' ? selector.selector : null;
      return quote ?? null;
    }
    return null;
  }),
  // anchorAnnotation is the real implementation from @semiont/core via the
  // `...actual` spread above. Don't mock it — these tests assert the
  // integration of segmentTextWithAnnotations with the actual scorer.
  };
});

function makeAnnotation(id: string, start: number, end: number, exact?: string): any {
  return {
    id,
    motivation: 'highlighting',
    target: {
      selector: [
        { type: 'TextPositionSelector', start, end },
        ...(exact ? [{ type: 'TextQuoteSelector', exact }] : []),
      ],
    },
  };
}

describe('segmentTextWithAnnotations', () => {
  it('returns empty segment for empty content', () => {
    const result = segmentTextWithAnnotations('', []);
    expect(result).toEqual([{ exact: '', start: 0, end: 0 }]);
  });

  it('returns full content as single segment when no annotations', () => {
    const result = segmentTextWithAnnotations('Hello world', []);
    expect(result).toEqual([{ exact: 'Hello world', start: 0, end: 11 }]);
  });

  it('segments content with a single annotation', () => {
    const content = 'Hello world';
    const ann = makeAnnotation('a1', 6, 11);
    const result = segmentTextWithAnnotations(content, [ann]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ exact: 'Hello ', start: 0, end: 6 });
    expect(result[1]).toEqual(expect.objectContaining({ exact: 'world', start: 6, end: 11, annotation: ann }));
  });

  it('segments content with annotation at start', () => {
    const content = 'Hello world';
    const ann = makeAnnotation('a1', 0, 5);
    const result = segmentTextWithAnnotations(content, [ann]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(expect.objectContaining({ exact: 'Hello', start: 0, end: 5, annotation: ann }));
    expect(result[1]).toEqual({ exact: ' world', start: 5, end: 11 });
  });

  it('handles multiple non-overlapping annotations', () => {
    const content = 'ABCDEFGHIJ';
    const ann1 = makeAnnotation('a1', 0, 3);
    const ann2 = makeAnnotation('a2', 5, 8);
    const result = segmentTextWithAnnotations(content, [ann1, ann2]);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(expect.objectContaining({ exact: 'ABC', start: 0, end: 3 }));
    expect(result[1]).toEqual({ exact: 'DE', start: 3, end: 5 });
    expect(result[2]).toEqual(expect.objectContaining({ exact: 'FGH', start: 5, end: 8 }));
    expect(result[3]).toEqual({ exact: 'IJ', start: 8, end: 10 });
  });

  it('skips overlapping annotations (keeps earlier one)', () => {
    const content = 'ABCDEFGHIJ';
    const ann1 = makeAnnotation('a1', 2, 6);
    const ann2 = makeAnnotation('a2', 4, 8); // overlaps with ann1
    const result = segmentTextWithAnnotations(content, [ann1, ann2]);

    // ann2 should be skipped
    const annotatedSegments = result.filter(s => s.annotation);
    expect(annotatedSegments).toHaveLength(1);
    expect(annotatedSegments[0]!.annotation!.id).toBe('a1');
  });

  it('filters out annotations with invalid positions', () => {
    const content = 'Hello';
    const badAnn = makeAnnotation('bad', 10, 20); // beyond content length
    const result = segmentTextWithAnnotations(content, [badAnn]);
    expect(result).toEqual([{ exact: 'Hello', start: 0, end: 5 }]);
  });

  it('filters out zero-length annotations', () => {
    const content = 'Hello';
    const zeroAnn = makeAnnotation('zero', 2, 2); // start === end
    const result = segmentTextWithAnnotations(content, [zeroAnn]);
    expect(result).toEqual([{ exact: 'Hello', start: 0, end: 5 }]);
  });

  it('covers full content when annotation spans entire document', () => {
    const content = 'Hello';
    const ann = makeAnnotation('full', 0, 5);
    const result = segmentTextWithAnnotations(content, [ann]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ exact: 'Hello', start: 0, end: 5, annotation: ann }));
  });

  it('re-anchors via TextQuoteSelector when TextPositionSelector is off by N chars', () => {
    // The motivating bug, end-to-end: stored annotation has start=16 but
    // the renderer's view of the content has "The question…" at position
    // 14. With the renderer relying purely on TextPositionSelector, the
    // highlight would land 2 chars off. With anchorAnnotation, the quote
    // selector's unique-occurrence wins and the highlight aligns.
    const exact = 'The question for decision';
    const content = `Kenison, C.J.\n${exact} by this appeal.`;
    const ann: any = {
      id: 'tag1',
      motivation: 'tagging',
      target: {
        selector: [
          { type: 'TextPositionSelector', start: 16, end: 16 + exact.length },
          { type: 'TextQuoteSelector', exact, prefix: 'Kenison, C.J.\nTh', suffix: ' by this appeal.' },
        ],
      },
    };

    const result = segmentTextWithAnnotations(content, [ann]);
    const annotated = result.find(s => s.annotation);
    expect(annotated).toBeDefined();
    expect(annotated!.start).toBe(14);
    expect(annotated!.end).toBe(14 + exact.length);
    expect(annotated!.exact).toBe(exact);
  });
});

// ─── Layer 3: strategy/confidence threading ─────────────────────────────

describe('segmentTextWithAnnotations — strategy + confidence on segments', () => {
  function annAt(id: string, start: number, end: number, exact: string): Annotation {
    return {
      id,
      motivation: 'highlighting',
      target: {
        selector: [
          { type: 'TextPositionSelector', start, end },
          { type: 'TextQuoteSelector', exact },
        ],
      },
    } as any;
  }

  it('marks fast-path anchors as high confidence', () => {
    const content = 'preamble important text';
    const ann = annAt('a', 9, 18, 'important');
    const seg = segmentTextWithAnnotations(content, [ann]).find(s => s.annotation);
    expect(seg!.strategy).toBe('fast-path');
    expect(seg!.confidence).toBe('high');
  });

  it('marks unique-occurrence anchors as high confidence', () => {
    const content = 'preamble important text';
    // Position selector deliberately wrong so fast-path fails but exact is unique.
    const ann = annAt('a', 0, 9, 'important');
    const seg = segmentTextWithAnnotations(content, [ann]).find(s => s.annotation);
    expect(seg!.strategy).toBe('unique-occurrence');
    expect(seg!.confidence).toBe('high');
  });

  it('marks position-fallback anchors as low confidence when only position is given', () => {
    const content = 'Hello World';
    const ann: any = {
      id: 'no-quote',
      motivation: 'highlighting',
      target: { selector: [{ type: 'TextPositionSelector', start: 0, end: 5 }] },
    };
    const seg = segmentTextWithAnnotations(content, [ann]).find(s => s.annotation);
    expect(seg!.strategy).toBe('position-fallback');
    expect(seg!.confidence).toBe('low');
  });
});

// ─── Layer 3: decoration metadata threading ─────────────────────────────

describe('getAnnotationDecorationMeta — strategy/confidence pass through', () => {
  const ann: Annotation = {
    id: 'a',
    motivation: 'highlighting',
    target: { selector: [{ type: 'TextPositionSelector', start: 0, end: 5 }] },
  } as any;

  it('omits strategy/confidence when the segment carries neither', () => {
    const meta = getAnnotationDecorationMeta(ann, false);
    expect(meta.strategy).toBeUndefined();
    expect(meta.confidence).toBeUndefined();
    expect(meta.className).not.toContain('annotation-low-confidence');
  });

  it('does not add the low-confidence class when confidence is high', () => {
    const meta = getAnnotationDecorationMeta(ann, false, { strategy: 'fast-path', confidence: 'high' });
    expect(meta.strategy).toBe('fast-path');
    expect(meta.confidence).toBe('high');
    expect(meta.className).not.toContain('annotation-low-confidence');
    // Tooltip stays clean — no need to surface fast-path to the user.
    expect(meta.tooltip).not.toContain('anchored:');
  });

  it('adds the low-confidence class and strategy in tooltip when confidence is medium', () => {
    const meta = getAnnotationDecorationMeta(ann, false, {
      strategy: 'position-tiebreaker',
      confidence: 'medium',
    });
    expect(meta.className).toContain('annotation-low-confidence');
    expect(meta.tooltip).toContain('position-tiebreaker');
  });

  it('adds the low-confidence class when confidence is low', () => {
    const meta = getAnnotationDecorationMeta(ann, false, {
      strategy: 'fuzzy-text',
      confidence: 'low',
    });
    expect(meta.className).toContain('annotation-low-confidence');
    expect(meta.tooltip).toContain('fuzzy-text');
  });
});

// ─── Layer 3: end-to-end through computeAnnotationDecorations ──────────

describe('computeAnnotationDecorations — strategy/confidence reach the decoration entry', () => {
  it('preserves strategy/confidence from segment onto the decoration metadata', () => {
    const ann: Annotation = {
      id: 'a',
      motivation: 'highlighting',
      target: { selector: [{ type: 'TextPositionSelector', start: 0, end: 5 }] },
    } as any;
    const segments = [
      { exact: '', start: 0, end: 0 },
      {
        exact: 'Hello',
        start: 0,
        end: 5,
        annotation: ann,
        strategy: 'fuzzy-text' as const,
        confidence: 'low' as const,
      },
    ];
    const entries = computeAnnotationDecorations(segments, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.meta.strategy).toBe('fuzzy-text');
    expect(entries[0]!.meta.confidence).toBe('low');
    expect(entries[0]!.meta.className).toContain('annotation-low-confidence');
  });
});

// ─── Layer 4: once-per-annotation degraded-anchor logging ──────────────

describe('segmentTextWithAnnotations — degraded-anchor logging', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _resetDegradedAnchorWarnings();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function annAt(id: string, exact: string): Annotation {
    return {
      id,
      motivation: 'highlighting',
      target: {
        selector: [{ type: 'TextQuoteSelector', exact }],
      },
    } as any;
  }

  it('does not log for high-confidence (unique-occurrence) anchors', () => {
    const content = 'preamble important text';
    segmentTextWithAnnotations(content, [annAt('a', 'important')]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs once per annotation for degraded strategies', () => {
    const content = 'foo bar foo baz foo';
    segmentTextWithAnnotations(content, [annAt('a', 'foo')]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('degraded strategy');
  });

  it('suppresses subsequent calls for the same annotation id', () => {
    const content = 'foo bar foo baz foo';
    const ann = annAt('a', 'foo');
    segmentTextWithAnnotations(content, [ann]);
    segmentTextWithAnnotations(content, [ann]);
    segmentTextWithAnnotations(content, [ann]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs once per distinct annotation id', () => {
    const content = 'foo bar foo baz foo';
    segmentTextWithAnnotations(content, [annAt('a', 'foo'), annAt('b', 'foo'), annAt('c', 'foo')]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('payload names the strategy and confidence', () => {
    const content = 'foo bar foo baz foo';
    segmentTextWithAnnotations(content, [annAt('a', 'foo')]);
    const payload = warnSpy.mock.calls[0]![1] as any;
    expect(payload.annotationId).toBe('a');
    expect(payload.strategy).toBe('position-tiebreaker');
    expect(payload.confidence).toBe('low');
  });
});
