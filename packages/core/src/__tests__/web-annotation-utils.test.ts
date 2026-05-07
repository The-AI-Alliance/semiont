import { describe, test, expect } from 'vitest';
import { annotationId } from '../identifiers';
import {
  getBodySource,
  getBodyType,
  isBodyResolved,
  getTargetSource,
  getTargetSelector,
  hasTargetSelector,
  isHighlight,
  isReference,
  isAssessment,
  isComment,
  isTag,
  getCommentText,
  isStubReference,
  isResolvedReference,
  getExactText,
  getAnnotationExactText,
  getPrimarySelector,
  getTextQuoteSelector,
  extractBoundingBox,
} from '../web-annotation-utils';
import {
  getTextPositionSelector,
  getSvgSelector,
  getFragmentSelector,
  validateSvgMarkup,
} from '../annotation-assembly';

import type { Annotation } from '../annotation-types';

function makeAnnotation(overrides?: Partial<Annotation>): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId('ann-1'),
    motivation: 'commenting',
    created: '2026-01-01T00:00:00Z',
    target: { source: 'http://example.com/res/1' },
    ...overrides,
  };
}

describe('getBodySource', () => {
  test('returns source from SpecificResource in array', () => {
    const body = [{ type: 'SpecificResource' as const, source: 'http://example.com/res/2' }];
    expect(getBodySource(body)).toBe('http://example.com/res/2');
  });

  test('returns null for empty array', () => {
    expect(getBodySource([])).toBeNull();
  });

  test('returns null for TextualBody array', () => {
    const body = [{ type: 'TextualBody' as const, value: 'hello' }];
    expect(getBodySource(body)).toBeNull();
  });

  test('returns source from single SpecificResource object', () => {
    const body = { type: 'SpecificResource' as const, source: 'http://example.com/res/3' };
    expect(getBodySource(body)).toBe('http://example.com/res/3');
  });
});

describe('getBodyType', () => {
  test('returns TextualBody from array', () => {
    expect(getBodyType([{ type: 'TextualBody' as const, value: 'hi' }])).toBe('TextualBody');
  });

  test('returns SpecificResource from array', () => {
    expect(getBodyType([{ type: 'SpecificResource' as const, source: 'http://example.com/res/1' }])).toBe('SpecificResource');
  });

  test('returns null for empty array', () => {
    expect(getBodyType([])).toBeNull();
  });

  test('returns type from single object', () => {
    expect(getBodyType({ type: 'TextualBody' as const, value: 'hi' })).toBe('TextualBody');
  });
});

describe('isBodyResolved', () => {
  test('returns true when SpecificResource in body', () => {
    expect(isBodyResolved([{ type: 'SpecificResource' as const, source: 'http://example.com/res/1' }])).toBe(true);
  });

  test('returns false for stub', () => {
    expect(isBodyResolved([])).toBe(false);
  });
});

describe('getTargetSource', () => {
  test('returns source from string target', () => {
    expect(getTargetSource('http://example.com/res/1')).toBe('http://example.com/res/1');
  });

  test('returns source from object target', () => {
    expect(getTargetSource({ source: 'http://example.com/res/1' })).toBe('http://example.com/res/1');
  });
});

describe('getTargetSelector', () => {
  test('returns undefined for string target', () => {
    expect(getTargetSelector('http://example.com/res/1')).toBeUndefined();
  });

  test('returns selector from object target', () => {
    const selector = { type: 'TextPositionSelector' as const, start: 0, end: 10 };
    expect(getTargetSelector({ source: 'http://example.com/res/1', selector })).toEqual(selector);
  });
});

describe('hasTargetSelector', () => {
  test('returns false for string target', () => {
    expect(hasTargetSelector('http://example.com')).toBe(false);
  });

  test('returns true when selector present', () => {
    expect(hasTargetSelector({ source: 'http://example.com/res/1', selector: { type: 'TextPositionSelector' as const, start: 0, end: 5 } })).toBe(true);
  });
});

describe('motivation type guards', () => {
  test('isHighlight', () => {
    expect(isHighlight(makeAnnotation({ motivation: 'highlighting' }))).toBe(true);
    expect(isHighlight(makeAnnotation({ motivation: 'commenting' }))).toBe(false);
  });

  test('isReference', () => {
    expect(isReference(makeAnnotation({ motivation: 'linking' }))).toBe(true);
  });

  test('isAssessment', () => {
    expect(isAssessment(makeAnnotation({ motivation: 'assessing' }))).toBe(true);
  });

  test('isComment', () => {
    expect(isComment(makeAnnotation({ motivation: 'commenting' }))).toBe(true);
  });

  test('isTag', () => {
    expect(isTag(makeAnnotation({ motivation: 'tagging' }))).toBe(true);
  });
});

describe('getCommentText', () => {
  test('returns text from comment annotation', () => {
    const ann = makeAnnotation({
      motivation: 'commenting',
      body: [{ type: 'TextualBody', value: 'Great point!' }],
    });
    expect(getCommentText(ann)).toBe('Great point!');
  });

  test('returns undefined for non-comment', () => {
    expect(getCommentText(makeAnnotation({ motivation: 'highlighting' }))).toBeUndefined();
  });

  test('returns undefined when body has no value', () => {
    const ann = makeAnnotation({
      motivation: 'commenting',
      body: [{ type: 'SpecificResource' as const, source: 'http://example.com/res/1' }],
    });
    expect(getCommentText(ann)).toBeUndefined();
  });
});

describe('isStubReference / isResolvedReference', () => {
  test('stub reference has no SpecificResource (body omitted)', () => {
    const ann = makeAnnotation({ motivation: 'linking' });
    expect(isStubReference(ann)).toBe(true);
    expect(isResolvedReference(ann)).toBe(false);
  });

  test('resolved reference has SpecificResource', () => {
    const ann = makeAnnotation({
      motivation: 'linking',
      body: [{ type: 'SpecificResource' as const, source: 'http://example.com/res/2' }],
    });
    expect(isStubReference(ann)).toBe(false);
    expect(isResolvedReference(ann)).toBe(true);
  });
});

describe('getExactText', () => {
  test('returns exact from TextQuoteSelector', () => {
    const selector = { type: 'TextQuoteSelector' as const, exact: 'hello world' };
    expect(getExactText(selector)).toBe('hello world');
  });

  test('returns exact from array with TextQuoteSelector', () => {
    const selectors = [
      { type: 'TextPositionSelector' as const, start: 0, end: 5 },
      { type: 'TextQuoteSelector' as const, exact: 'hello' },
    ];
    expect(getExactText(selectors)).toBe('hello');
  });

  test('returns empty string for TextPositionSelector only', () => {
    expect(getExactText({ type: 'TextPositionSelector' as const, start: 0, end: 5 })).toBe('');
  });

  test('returns empty string for undefined selector', () => {
    expect(getExactText(undefined)).toBe('');
  });
});

describe('getAnnotationExactText', () => {
  test('returns exact text from annotation target', () => {
    const ann = makeAnnotation({
      target: {
        source: 'http://example.com/res/1',
        selector: { type: 'TextQuoteSelector' as const, exact: 'selected text' },
      },
    });
    expect(getAnnotationExactText(ann)).toBe('selected text');
  });
});

describe('getPrimarySelector', () => {
  test('returns single selector', () => {
    const s = { type: 'TextPositionSelector' as const, start: 0, end: 5 };
    expect(getPrimarySelector(s)).toBe(s);
  });

  test('returns first from array', () => {
    const s1 = { type: 'TextPositionSelector' as const, start: 0, end: 5 };
    const s2 = { type: 'TextQuoteSelector' as const, exact: 'hello' };
    expect(getPrimarySelector([s1, s2])).toBe(s1);
  });

  test('throws for empty array', () => {
    expect(() => getPrimarySelector([])).toThrow('Empty selector array');
  });
});

describe('getTextPositionSelector', () => {
  test('finds TextPositionSelector in array', () => {
    const tps = { type: 'TextPositionSelector' as const, start: 10, end: 20 };
    expect(getTextPositionSelector([tps])).toEqual(tps);
  });

  test('returns null when not found', () => {
    expect(getTextPositionSelector({ type: 'TextQuoteSelector' as const, exact: 'x' })).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(getTextPositionSelector(undefined)).toBeNull();
  });
});

describe('getTextQuoteSelector', () => {
  test('finds TextQuoteSelector', () => {
    const tqs = { type: 'TextQuoteSelector' as const, exact: 'hello' };
    expect(getTextQuoteSelector(tqs)).toEqual(tqs);
  });

  test('returns null when not found', () => {
    expect(getTextQuoteSelector({ type: 'TextPositionSelector' as const, start: 0, end: 5 })).toBeNull();
  });
});

describe('getSvgSelector', () => {
  test('finds SvgSelector', () => {
    const ss = { type: 'SvgSelector' as const, value: '<svg>...</svg>' };
    expect(getSvgSelector(ss)).toEqual(ss);
  });

  test('returns null for undefined', () => {
    expect(getSvgSelector(undefined)).toBeNull();
  });
});

describe('getFragmentSelector', () => {
  test('finds FragmentSelector', () => {
    const fs = { type: 'FragmentSelector' as const, value: 'xywh=0,0,100,100', conformsTo: 'http://www.w3.org/TR/media-frags/' };
    expect(getFragmentSelector(fs)).toEqual(fs);
  });

  test('returns null for undefined', () => {
    expect(getFragmentSelector(undefined)).toBeNull();
  });
});

describe('validateSvgMarkup', () => {
  test('accepts valid SVG', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10"/></svg>';
    expect(validateSvgMarkup(svg)).toBeNull();
  });

  test('rejects SVG without xmlns', () => {
    const svg = '<svg><rect x="0" y="0" width="10" height="10"/></svg>';
    expect(validateSvgMarkup(svg)).toContain('xmlns');
  });

  test('rejects SVG without closing tag', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10"/>';
    expect(validateSvgMarkup(svg)).toContain('opening and closing tags');
  });

  test('rejects SVG without shape', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>';
    expect(validateSvgMarkup(svg)).toContain('shape element');
  });
});

describe('extractBoundingBox', () => {
  test('extracts from viewBox', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><rect/></svg>';
    expect(extractBoundingBox(svg)).toEqual({ x: 0, y: 0, width: 100, height: 200 });
  });

  test('extracts from width/height', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect/></svg>';
    expect(extractBoundingBox(svg)).toEqual({ x: 0, y: 0, width: 300, height: 400 });
  });

  test('returns null when no dimensions', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(extractBoundingBox(svg)).toBeNull();
  });
});
