import { describe, test, expect } from 'vitest';
import { extractContext, validateAndCorrectOffsets } from '../text-context';

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
    // Create content where a naive 64-char prefix would cut mid-word
    const longWord = 'superlongword';
    const content = `${longWord} selected text and more`;
    // Selection starts after the long word and space
    const start = longWord.length + 1;
    const end = start + 13; // "selected text"
    const result = extractContext(content, start, end);
    // Prefix should include the full long word, not cut it
    expect(result.prefix).toBe(`${longWord} `);
  });
});

describe('validateAndCorrectOffsets', () => {
  const content = 'The United States Congress passed the bill yesterday.';

  test('returns uncorrected when offsets are exact', () => {
    const result = validateAndCorrectOffsets(content, 4, 17, 'United States');
    expect(result.corrected).toBe(false);
    expect(result.start).toBe(4);
    expect(result.end).toBe(17);
    expect(result.exact).toBe('United States');
    expect(result.matchQuality).toBe('exact');
    expect(result.prefix).toBeDefined();
    expect(result.suffix).toBeDefined();
  });

  test('corrects wrong offsets via exact search', () => {
    // AI says start=0, but text is at 4
    const result = validateAndCorrectOffsets(content, 0, 13, 'United States');
    expect(result.corrected).toBe(true);
    expect(result.start).toBe(4);
    expect(result.end).toBe(17);
    expect(result.exact).toBe('United States');
  });

  test('throws when text is not found', () => {
    expect(() =>
      validateAndCorrectOffsets(content, 0, 10, 'Nonexistent Text That Does Not Appear')
    ).toThrow('Cannot find acceptable match');
  });

  test('finds case-insensitive match', () => {
    const result = validateAndCorrectOffsets(content, 0, 13, 'united states');
    expect(result.corrected).toBe(true);
    expect(result.start).toBe(4);
    expect(result.end).toBe(17);
    // exact should be the actual text from document
    expect(result.exact).toBe('United States');
  });
});

/**
 * Offset round-trip across charset boundaries.
 *
 * These cases replace the old
 * `packages/jobs/src/__tests__/workers/detection/entity-extractor-charset.test.ts`,
 * which tested the same invariant end-to-end through the pre-#651 worker
 * wrapper. The real system-under-test is `validateAndCorrectOffsets` —
 * the worker wrapper just plumbed an extractor's claimed offsets through
 * it. Testing the function directly removes the mock scaffolding and
 * keeps the invariant co-located with its implementation.
 *
 * Invariant: whatever start/end `validateAndCorrectOffsets` returns,
 * `content.substring(start, end) === exact` — even when the content
 * contains multibyte (CJK), extended-Latin (accents), or smart-quote
 * characters that change the relationship between byte offsets and
 * JS UTF-16 code-unit offsets.
 */
describe('validateAndCorrectOffsets - charset handling', () => {
  const checkRoundTrip = (content: string, start: number, end: number, exact: string) => {
    const r = validateAndCorrectOffsets(content, start, end, exact);
    expect(content.substring(r.start, r.end)).toBe(r.exact);
    return r;
  };

  test('UTF-8 multibyte (CJK) characters before the match', () => {
    // 世界 is two JS UTF-16 code units each (well, surrogate-pair-free BMP
    // codepoints — 1 code unit each). "世界 " before "Location".
    const content = 'The Person works in Location with 世界 background';
    const start = content.indexOf('Location');
    const end = start + 'Location'.length;
    const r = checkRoundTrip(content, start, end, 'Location');
    expect(r.exact).toBe('Location');
  });

  test('extended Latin characters in prefix and suffix (café, résumé, París)', () => {
    const content = 'The café serves résumé to Person in París Location';
    const personStart = content.indexOf('Person');
    checkRoundTrip(content, personStart, personStart + 'Person'.length, 'Person');
    const locStart = content.indexOf('Location');
    checkRoundTrip(content, locStart, locStart + 'Location'.length, 'Location');
  });

  test('smart quotes and en-dashes surrounding the match', () => {
    const content = 'The Person said “Location” with –dashes–';
    const personStart = content.indexOf('Person');
    checkRoundTrip(content, personStart, personStart + 'Person'.length, 'Person');
    const locStart = content.indexOf('Location');
    checkRoundTrip(content, locStart, locStart + 'Location'.length, 'Location');
  });

  test('the match itself contains accented characters (café)', () => {
    const content = 'café is a nice place';
    const r = checkRoundTrip(content, 0, 4, 'café');
    expect(r.exact).toBe('café');
    expect(r.start).toBe(0);
    expect(r.end).toBe(4);
  });

  test('multiple accented-text matches at different positions', () => {
    const content = 'Person López works at Café de París Location serving résumé to another Person';
    // First Person
    const p1 = content.indexOf('Person');
    checkRoundTrip(content, p1, p1 + 'Person'.length, 'Person');
    // Location (after several accented words)
    const loc = content.indexOf('Location');
    checkRoundTrip(content, loc, loc + 'Location'.length, 'Location');
    // Second Person (after more accented words)
    const p2 = content.indexOf('Person', p1 + 1);
    checkRoundTrip(content, p2, p2 + 'Person'.length, 'Person');
  });

  test('corrects drifted offsets in multibyte content', () => {
    // Caller (AI) reports offsets based on a byte-indexed view; validator
    // should still locate the match via exact-text search and return
    // correct code-unit offsets.
    const content = 'Prelude with 世界 then the Person appears here';
    const truePersonStart = content.indexOf('Person');
    // Feed a deliberately wrong start offset; exact-text search should
    // correct it to truePersonStart.
    const r = validateAndCorrectOffsets(content, 0, 'Person'.length, 'Person');
    expect(r.corrected).toBe(true);
    expect(r.start).toBe(truePersonStart);
    expect(r.end).toBe(truePersonStart + 'Person'.length);
    expect(content.substring(r.start, r.end)).toBe('Person');
  });
});
