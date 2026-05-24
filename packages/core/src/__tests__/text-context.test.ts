import { describe, test, it, expect } from 'vitest';
import { extractContext, reconcileSelector, type ReconciledSelector } from '../text-context';

describe('extractContext', () => {
  test('extracts prefix and suffix', () => {
    const content = 'The quick brown fox jumps over the lazy dog.';
    const result = extractContext(content, 10, 19); // "brown fox"
    expect(result.prefix).toBe('The quick ');
    expect(result.suffix).toBe(' jumps over the lazy dog.');
  });

  test('returns undefined prefix at start of content', () => {
    const content = 'Hello World';
    const result = extractContext(content, 0, 5);
    expect(result.prefix).toBeUndefined();
    expect(result.suffix).toBe(' World');
  });

  test('returns undefined suffix at end of content', () => {
    const content = 'Hello World';
    const result = extractContext(content, 6, 11);
    expect(result.prefix).toBe('Hello ');
    expect(result.suffix).toBeUndefined();
  });

  test('extends to word boundaries', () => {
    const longWord = 'superlongword';
    const content = `${longWord} selected text and more`;
    const start = longWord.length + 1;
    const end = start + 13;
    const result = extractContext(content, start, end);
    expect(result.prefix).toBe(`${longWord} `);
  });
});

// ─── Layer 1: per-anchor-method tests ────────────────────────────────────

describe('reconcileSelector — unique-match', () => {
  it('anchors when exact appears once in content', () => {
    const content = 'The United States Congress passed the bill yesterday.';
    const result = reconcileSelector(content, { exact: 'United States' });
    expect(result).toMatchObject<Partial<ReconciledSelector>>({
      start: 4,
      end: 17,
      exact: 'United States',
      anchorMethod: 'unique-match',
    });
    expect(result?.prefix).toBe('The ');
    expect(result?.suffix).toBe(' Congress passed the bill yesterday.');
  });

  it('does not carry LLM-emitted prefix/suffix into the result', () => {
    const content = 'The United States Congress passed the bill yesterday.';
    const result = reconcileSelector(content, {
      exact: 'United States',
      prefix: 'NOT THE SOURCE PREFIX',
      suffix: 'NOT THE SOURCE SUFFIX',
    });
    // Single occurrence → prefix/suffix from source, not from LLM.
    expect(result?.prefix).toBe('The ');
    expect(result?.suffix).toBe(' Congress passed the bill yesterday.');
  });
});

describe('reconcileSelector — context-recovered', () => {
  const content =
    'Section A: the parties agree to terms. Section B: the parties agree to conditions. Section C: the parties agree to schedule.';

  it('uses LLM-emitted prefix to pick the correct occurrence', () => {
    const result = reconcileSelector(content, {
      exact: 'the parties agree',
      prefix: 'Section B: ',
    });
    const expected = content.indexOf('Section B: ') + 'Section B: '.length;
    expect(result?.start).toBe(expected);
    expect(result?.anchorMethod).toBe('context-recovered');
  });

  it('uses LLM-emitted suffix to pick the correct occurrence', () => {
    const result = reconcileSelector(content, {
      exact: 'the parties agree',
      suffix: ' to schedule',
    });
    const expected = content.indexOf('Section C: ') + 'Section C: '.length;
    expect(result?.start).toBe(expected);
    expect(result?.anchorMethod).toBe('context-recovered');
  });
});

describe('reconcileSelector — first-of-many', () => {
  it('falls back to first occurrence when context does not disambiguate', () => {
    const content = 'foo foo foo';
    const result = reconcileSelector(content, { exact: 'foo' });
    expect(result?.start).toBe(0);
    expect(result?.anchorMethod).toBe('first-of-many');
  });

  it('flags first-of-many when LLM context was provided but none matched', () => {
    const content = 'foo foo foo';
    const result = reconcileSelector(content, {
      exact: 'foo',
      prefix: 'PREFIX_NOT_IN_CONTENT',
      suffix: 'SUFFIX_NOT_IN_CONTENT',
    });
    expect(result?.anchorMethod).toBe('first-of-many');
    expect(result?.start).toBe(0);
  });
});

describe('reconcileSelector — fuzzy-match', () => {
  it('recovers via case-insensitive search when verbatim fails', () => {
    const content = 'The United States Congress passed the bill yesterday.';
    const result = reconcileSelector(content, { exact: 'united states' });
    expect(result).toMatchObject<Partial<ReconciledSelector>>({
      start: 4,
      end: 17,
      exact: 'United States',
      anchorMethod: 'fuzzy-match',
    });
    // The stored `exact` is the source's actual text, not the LLM's
    // case-different version.
    expect(result?.exact).toBe('United States');
  });

  it('the real bug: LLM straight-quotes vs source smart-quotes anchors at the correct offset', () => {
    // This is the legal-KB failure, write-side. Source has a smart quote;
    // the LLM echoed `exact` with a straight quote. Verbatim indexOf fails,
    // the fuzzy/normalized branch recovers it — and must land at the true
    // offset (14), storing the SOURCE's text (smart quotes), not the LLM's.
    // Before the findBestTextMatch map fix this returned offset 16.
    const exact = 'The question for decision to "any person" today';
    const content = `Kenison, C.J.\nThe question for decision to “any person” today and more.`;
    const result = reconcileSelector(content, { exact });
    expect(result).not.toBeNull();
    expect(result!.start).toBe(14);
    expect(result!.anchorMethod).toBe('fuzzy-match');
    // Stored exact is the source's real text (smart quotes), verifiable
    // against the stored offset.
    expect(content.substring(result!.start, result!.end)).toBe(result!.exact);
    expect(result!.exact).toContain('“any person”');
  });
});

describe('reconcileSelector — dropped (null)', () => {
  it('returns null when exact is not present anywhere', () => {
    const content = 'The quick brown fox jumps over the lazy dog.';
    const result = reconcileSelector(content, {
      exact: 'Nonexistent Text That Does Not Appear',
    });
    expect(result).toBeNull();
  });

  it('returns null for empty exact', () => {
    expect(reconcileSelector('Some content', { exact: '' })).toBeNull();
  });
});

// ─── Layer 1: cross-cutting invariants ───────────────────────────────────

describe('reconcileSelector — no-overlap invariant on output', () => {
  const content = 'Kenison, C.J.\nThe question for decision by this appeal.';

  it('content.substring(start, end) === exact for unique-match', () => {
    const result = reconcileSelector(content, { exact: 'The question for decision' });
    expect(result).not.toBeNull();
    expect(content.substring(result!.start, result!.end)).toBe(result!.exact);
  });

  it('content.substring(start - prefix.length, start) === prefix when prefix present', () => {
    const result = reconcileSelector(content, { exact: 'The question for decision' });
    expect(result).not.toBeNull();
    if (result!.prefix !== undefined) {
      expect(content.substring(result!.start - result!.prefix.length, result!.start)).toBe(result!.prefix);
    }
  });

  it('content.substring(end, end + suffix.length) === suffix when suffix present', () => {
    const result = reconcileSelector(content, { exact: 'The question for decision' });
    expect(result).not.toBeNull();
    if (result!.suffix !== undefined) {
      expect(content.substring(result!.end, result!.end + result!.suffix.length)).toBe(result!.suffix);
    }
  });

  it('property-style: every reconcile returns a selector consistent with content', () => {
    const exact = 'target substring';
    const content = `prefix garbage ${exact} suffix garbage`;
    const truePos = content.indexOf(exact);
    const result = reconcileSelector(content, { exact });
    expect(result).not.toBeNull();
    expect(result!.start).toBe(truePos);
    expect(content.substring(result!.start, result!.end)).toBe(result!.exact);
    if (result!.prefix !== undefined) {
      expect(content.substring(result!.start - result!.prefix.length, result!.start)).toBe(result!.prefix);
    }
    if (result!.suffix !== undefined) {
      expect(content.substring(result!.end, result!.end + result!.suffix.length)).toBe(result!.suffix);
    }
  });
});

describe('reconcileSelector — LLM prefix/suffix never leak into output', () => {
  it('overlapping LLM prefix is replaced with a source-extracted prefix', () => {
    // The motivating bug from the design plan: LLM emits a prefix that
    // overlaps the start of `exact`. Output must extract prefix from
    // source at the corrected start, so the overlap disappears.
    const exact = 'The question for decision';
    const content = `Kenison, C.J.\n${exact} by this appeal.`;
    const result = reconcileSelector(content, {
      exact,
      prefix: 'Kenison, C.J.\nTh', // overlapping with start of exact
      suffix: ' by this appeal.',
    });
    expect(result).not.toBeNull();
    expect(result!.start).toBe(14);
    // The returned prefix must end where exact begins.
    expect(result!.prefix).not.toContain('Th');
    expect(content.substring(result!.start - result!.prefix!.length, result!.start)).toBe(result!.prefix);
  });
});

// ─── Charset round-trip (kept from prior coverage) ───────────────────────

describe('reconcileSelector — charset handling', () => {
  const checkRoundTrip = (content: string, exact: string) => {
    const r = reconcileSelector(content, { exact });
    expect(r).not.toBeNull();
    expect(content.substring(r!.start, r!.end)).toBe(r!.exact);
    return r!;
  };

  test('UTF-8 multibyte (CJK) characters before the match', () => {
    const content = 'The Person works in Location with 世界 background';
    const r = checkRoundTrip(content, 'Location');
    expect(r.exact).toBe('Location');
  });

  test('extended Latin characters in prefix and suffix', () => {
    const content = 'The café serves résumé to Person in París Location';
    checkRoundTrip(content, 'Person');
    checkRoundTrip(content, 'Location');
  });

  test('smart quotes and en-dashes surrounding the match', () => {
    const content = 'The Person said “Location” with –dashes–';
    checkRoundTrip(content, 'Person');
    checkRoundTrip(content, 'Location');
  });

  test('the match itself contains accented characters (café)', () => {
    const content = 'café is a nice place';
    const r = checkRoundTrip(content, 'café');
    expect(r.exact).toBe('café');
    expect(r.start).toBe(0);
    expect(r.end).toBe(4);
  });

  test('anchors correctly in multibyte content even without offsets', () => {
    const content = 'Prelude with 世界 then the Person appears here';
    const truePersonStart = content.indexOf('Person');
    const r = reconcileSelector(content, { exact: 'Person' });
    expect(r).not.toBeNull();
    expect(r!.start).toBe(truePersonStart);
    expect(r!.end).toBe(truePersonStart + 'Person'.length);
    expect(content.substring(r!.start, r!.end)).toBe('Person');
  });
});
