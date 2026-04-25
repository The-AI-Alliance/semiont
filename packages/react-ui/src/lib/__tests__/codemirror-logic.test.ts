import { describe, it, expect, vi } from 'vitest';
import {
  convertSegmentPositions,
  getAnnotationTooltip,
  getAnnotationDecorationMeta,
  computeAnnotationDecorations,
  computeWidgetDecorations,
} from '../codemirror-logic';
import type { TextSegment } from '../codemirror-logic';

// Mock api-client type guards
vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return {
    ...actual,
  isHighlight: vi.fn((ann: any) => ann.motivation === 'highlighting'),
  isComment: vi.fn((ann: any) => ann.motivation === 'commenting'),
  isReference: vi.fn((ann: any) => ann.motivation === 'linking'),
  isResolvedReference: vi.fn((ann: any) => ann.motivation === 'linking' && ann.body?.some?.((b: any) => b.source)),
  isAssessment: vi.fn((ann: any) => ann.motivation === 'assessing'),
  isTag: vi.fn((ann: any) => ann.motivation === 'tagging'),
  getBodySource: vi.fn((body: any) => body?.[0]?.source ?? null),
  };
});

// Mock annotation-registry
vi.mock('../annotation-registry', () => ({
  ANNOTATORS: {
    highlight: { className: 'highlight-class', matchesAnnotation: (ann: any) => ann.motivation === 'highlighting' },
    comment: { className: 'comment-class', matchesAnnotation: (ann: any) => ann.motivation === 'commenting' },
    reference: { className: 'reference-class', matchesAnnotation: (ann: any) => ann.motivation === 'linking' },
    assessment: { className: 'assessment-class', matchesAnnotation: (ann: any) => ann.motivation === 'assessing' },
    tag: { className: 'tag-class', matchesAnnotation: (ann: any) => ann.motivation === 'tagging' },
  },
}));

function makeAnnotation(id: string, motivation: string, body?: any[]): any {
  return { id, motivation, body: body ?? [] };
}

function makeSegment(start: number, end: number, annotation?: any): TextSegment {
  return {
    exact: 'x'.repeat(end - start),
    start,
    end,
    annotation,
  };
}

describe('convertSegmentPositions', () => {
  it('returns segments unchanged when content has no CRLF', () => {
    const segments = [makeSegment(0, 5), makeSegment(10, 15)];
    const result = convertSegmentPositions(segments, 'Hello world, this is a test');
    expect(result).toBe(segments); // Same reference
  });

  it('adjusts positions for CRLF content', () => {
    // Content: "ab\r\ncd\r\nef" — CRLFs at positions 2 and 6
    const content = 'ab\r\ncd\r\nef';
    const segments = [makeSegment(4, 6), makeSegment(8, 10)];
    const result = convertSegmentPositions(segments, content);

    // Position 4 has 1 CRLF before it (at pos 2) → 4-1=3
    expect(result[0]!.start).toBe(3);
    // Position 6 has 1 CRLF before it → 6-1=5
    expect(result[0]!.end).toBe(5);
    // Position 8 has 2 CRLFs before it → 8-2=6
    expect(result[1]!.start).toBe(6);
    // Position 10 has 2 CRLFs before it → 10-2=8
    expect(result[1]!.end).toBe(8);
  });

  it('handles position at start of content', () => {
    const content = '\r\nabc';
    const segments = [makeSegment(0, 2)];
    const result = convertSegmentPositions(segments, content);
    // Position 0: no CRLFs before → 0
    expect(result[0]!.start).toBe(0);
    // Position 2: 1 CRLF at pos 0, which is < 2 → 2-1=1
    expect(result[0]!.end).toBe(1);
  });
});

describe('getAnnotationTooltip', () => {
  it('returns Comment for commenting motivation', () => {
    expect(getAnnotationTooltip(makeAnnotation('1', 'commenting'))).toBe('Comment');
  });

  it('returns Highlight for highlighting motivation', () => {
    expect(getAnnotationTooltip(makeAnnotation('1', 'highlighting'))).toBe('Highlight');
  });

  it('returns Assessment for assessing motivation', () => {
    expect(getAnnotationTooltip(makeAnnotation('1', 'assessing'))).toBe('Assessment');
  });

  it('returns Tag for tagging motivation', () => {
    expect(getAnnotationTooltip(makeAnnotation('1', 'tagging'))).toBe('Tag');
  });

  it('returns Unresolved Reference for linking motivation without body source', () => {
    expect(getAnnotationTooltip(makeAnnotation('1', 'linking'))).toBe('Unresolved Reference');
  });

  it('returns Resolved Reference for linking with body source', () => {
    expect(getAnnotationTooltip(makeAnnotation('1', 'linking', [{ source: 'doc-123' }]))).toBe('Resolved Reference');
  });

  it('returns Annotation for unknown motivation', () => {
    expect(getAnnotationTooltip(makeAnnotation('1', 'bookmarking'))).toBe('Annotation');
  });
});

describe('getAnnotationDecorationMeta', () => {
  it('returns correct className from registry', () => {
    const meta = getAnnotationDecorationMeta(makeAnnotation('ann-1', 'highlighting'), false);
    expect(meta.className).toBe('highlight-class');
    expect(meta.annotationId).toBe('ann-1');
    expect(meta.annotationType).toBe('highlight');
  });

  it('adds sparkle class when isNew', () => {
    const meta = getAnnotationDecorationMeta(makeAnnotation('ann-1', 'commenting'), true);
    expect(meta.className).toBe('comment-class annotation-sparkle');
  });

  it('sets annotationType to comment for commenting', () => {
    const meta = getAnnotationDecorationMeta(makeAnnotation('1', 'commenting'), false);
    expect(meta.annotationType).toBe('comment');
  });

  it('sets annotationType to reference for linking', () => {
    const meta = getAnnotationDecorationMeta(makeAnnotation('1', 'linking'), false);
    expect(meta.annotationType).toBe('reference');
  });

  it('sets annotationType to assessment for assessing', () => {
    const meta = getAnnotationDecorationMeta(makeAnnotation('1', 'assessing'), false);
    expect(meta.annotationType).toBe('assessment');
  });

  it('sets annotationType to tag for tagging', () => {
    const meta = getAnnotationDecorationMeta(makeAnnotation('1', 'tagging'), false);
    expect(meta.annotationType).toBe('tag');
  });

  it('falls back to annotation-highlight for unknown motivation', () => {
    const meta = getAnnotationDecorationMeta(makeAnnotation('1', 'bookmarking'), false);
    expect(meta.className).toBe('annotation-highlight');
  });
});

describe('computeAnnotationDecorations', () => {
  it('returns empty array for no annotated segments', () => {
    const segments = [makeSegment(0, 10)];
    expect(computeAnnotationDecorations(segments)).toEqual([]);
  });

  it('returns decoration entries sorted by start position', () => {
    const segments = [
      makeSegment(10, 15, makeAnnotation('b', 'highlighting')),
      makeSegment(0, 5, makeAnnotation('a', 'commenting')),
    ];
    const result = computeAnnotationDecorations(segments);
    expect(result).toHaveLength(2);
    expect(result[0]!.start).toBe(0);
    expect(result[1]!.start).toBe(10);
  });

  it('marks new annotations with sparkle', () => {
    const segments = [makeSegment(0, 5, makeAnnotation('new-1', 'highlighting'))];
    const newIds = new Set(['new-1']);
    const result = computeAnnotationDecorations(segments, newIds);
    expect(result[0]!.meta.className).toContain('annotation-sparkle');
  });
});

describe('computeWidgetDecorations', () => {
  it('returns empty array for non-reference segments', () => {
    const segments = [makeSegment(0, 5, makeAnnotation('1', 'highlighting'))];
    expect(computeWidgetDecorations(segments, null)).toEqual([]);
  });

  it('returns widget metadata for reference annotations', () => {
    const ann = makeAnnotation('ref-1', 'linking', [{ source: 'doc-abc' }]);
    const segments = [makeSegment(0, 10, ann)];
    const getName = (id: string) => id === 'doc-abc' ? 'My Document' : undefined;

    const result = computeWidgetDecorations(segments, null, getName);
    expect(result).toHaveLength(1);
    expect(result[0]!.annotationId).toBe('ref-1');
    expect(result[0]!.position).toBe(10); // end of segment
    expect(result[0]!.targetName).toBe('My Document');
    expect(result[0]!.isGenerating).toBe(false);
  });

  it('marks generating reference', () => {
    const ann = makeAnnotation('ref-1', 'linking');
    const segments = [makeSegment(0, 5, ann)];
    const result = computeWidgetDecorations(segments, 'ref-1');
    expect(result[0]!.isGenerating).toBe(true);
  });

  it('sorts by end position', () => {
    const segments = [
      makeSegment(20, 30, makeAnnotation('b', 'linking')),
      makeSegment(0, 10, makeAnnotation('a', 'linking')),
    ];
    const result = computeWidgetDecorations(segments, null);
    expect(result[0]!.position).toBe(10);
    expect(result[1]!.position).toBe(30);
  });
});
