import { describe, test, expect } from 'vitest';
import { extractContext } from '../text-context';

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

// ─── What an offset counts ───────────────────────────────────────────────

// `start` and `end` are offsets: they count code points, and so do the 64
// and the 32 of the context. The table (reconcile-cases.json) holds the
// counts; this holds that `extractContext` itself is given offsets.
describe('extractContext — offsets count code points', () => {
  test('is given offsets, not a string\'s own positions', () => {
    const content = '😀 The quick brown fox jumps over the lazy dog.';
    const result = extractContext(content, 12, 21); // "brown fox"
    expect(result.prefix).toBe('😀 The quick ');
    expect(result.suffix).toBe(' jumps over the lazy dog.');
  });

  test('a span that ends the text, by its code points, has no suffix', () => {
    const content = 'end 🙂';
    expect(extractContext(content, 4, 5)).toEqual({ prefix: 'end ' });
  });
});
