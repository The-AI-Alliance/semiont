import { describe, it, expect, vi } from 'vitest';
import { segmentTextWithAnnotations } from '../text-segmentation';

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
  findTextWithContext: vi.fn((_content: string, exact: string, _prefix: any, _suffix: any, hintStart?: number) => {
    // Simple mock: use hint start if available, otherwise return null
    if (hintStart !== undefined) return { start: hintStart, end: hintStart + exact.length };
    return null;
  }),
  buildContentCache: vi.fn(() => ({})),
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
});
