import { describe, test, expect } from 'vitest';
import { extractContext, validateAndCorrectOffsets } from '../../utils/text-context';

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
