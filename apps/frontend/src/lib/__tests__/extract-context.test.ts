import { describe, it, expect } from 'vitest';

/**
 * Tests for extractContext function
 *
 * Note: This function is currently private in AnnotateView.tsx
 * These tests document expected behavior and can be used if the function is extracted
 */

// Copy of extractContext for testing
function extractContext(content: string, start: number, end: number): { prefix?: string; suffix?: string } {
  const CONTEXT_LENGTH = 64;
  const MAX_EXTENSION = 32;
  const result: { prefix?: string; suffix?: string } = {};

  // Extract prefix (up to CONTEXT_LENGTH chars before start, extended to word boundary)
  if (start > 0) {
    let prefixStart = Math.max(0, start - CONTEXT_LENGTH);

    // Extend backward to word boundary (whitespace or punctuation)
    let extensionCount = 0;
    while (prefixStart > 0 && extensionCount < MAX_EXTENSION) {
      const char = content[prefixStart - 1];
      if (!char || /[\s.,;:!?'"()\[\]{}<>\/\\]/.test(char)) {
        break;
      }
      prefixStart--;
      extensionCount++;
    }

    result.prefix = content.substring(prefixStart, start);
  }

  // Extract suffix (up to CONTEXT_LENGTH chars after end, extended to word boundary)
  if (end < content.length) {
    let suffixEnd = Math.min(content.length, end + CONTEXT_LENGTH);

    // Extend forward to word boundary (whitespace or punctuation)
    let extensionCount = 0;
    while (suffixEnd < content.length && extensionCount < MAX_EXTENSION) {
      const char = content[suffixEnd];
      if (!char || /[\s.,;:!?'"()\[\]{}<>\/\\]/.test(char)) {
        break;
      }
      suffixEnd++;
      extensionCount++;
    }

    result.suffix = content.substring(end, suffixEnd);
  }

  return result;
}

describe('extractContext - Word Boundary Extension', () => {
  it('should not cut words in half for prefix', () => {
    const content = 'United States Senator?\nThe quick brown fox jumps over the lazy dog';
    const start = content.indexOf('The quick');
    const end = start + 'The quick'.length;

    const result = extractContext(content, start, end);

    // Should include complete "United States Senator?\n" not "nited States Senator?\n"
    expect(result.prefix).toBe('United States Senator?\n');
    expect(result.prefix?.startsWith('nited')).toBe(false);
  });

  it('should not cut words in half for suffix', () => {
    const content = 'The quick brown fox jumps over the lazy dog running fast';
    const start = content.indexOf('quick brown');
    const end = start + 'quick brown'.length;

    const result = extractContext(content, start, end);

    // Should extend to complete "fox jumps over the lazy dog" not "fox jumps over the lazy do"
    expect(result.suffix).toContain('fox jumps over the lazy dog');
    expect(result.suffix?.endsWith('g runn')).toBe(false);
  });

  it('should include full context up to CONTEXT_LENGTH', () => {
    const content = 'First sentence. The second sentence. Third sentence.';
    const start = content.indexOf('second sentence');
    const end = start + 'second sentence'.length;

    const result = extractContext(content, start, end);

    // Should include full context, extended to word boundary
    expect(result.prefix).toBe('First sentence. The ');
    // Should include suffix, extended to word boundary
    expect(result.suffix).toBe('. Third sentence.');
  });

  it('should extend to word boundaries including punctuation', () => {
    const content = 'Some text (with parentheses) and [brackets] here';
    const start = content.indexOf('with parentheses');
    const end = start + 'with parentheses'.length;

    const result = extractContext(content, start, end);

    // Includes context up to boundary, then extends to complete words
    expect(result.prefix).toBe('Some text (');
    expect(result.suffix).toBe(') and [brackets] here');
  });

  it('should limit extension to MAX_EXTENSION', () => {
    // Create a very long word (more than MAX_EXTENSION chars)
    const longWord = 'a'.repeat(100);
    const content = `${longWord} The selected text here`;
    const start = content.indexOf('The selected');
    const end = start + 'The selected'.length;

    const result = extractContext(content, start, end);

    // Should stop extending after MAX_EXTENSION (32) chars
    // Will include space + last 63 chars of long word
    expect(result.prefix!.length).toBeLessThanOrEqual(64 + 32); // CONTEXT_LENGTH + MAX_EXTENSION
  });

  it('should handle selections at start of content', () => {
    const content = 'The quick brown fox';
    const start = 0;
    const end = 3;

    const result = extractContext(content, start, end);

    expect(result.prefix).toBeUndefined();
    expect(result.suffix).toBe(' quick brown fox');
  });

  it('should handle selections at end of content', () => {
    const content = 'The quick brown fox';
    const start = content.indexOf('fox');
    const end = content.length;

    const result = extractContext(content, start, end);

    expect(result.prefix).toContain('quick brown ');
    expect(result.suffix).toBeUndefined();
  });

  it('should reproduce the bug case from tagging annotation', () => {
    // Simplified version of the actual bug case
    const content = 'Who is a United States Senator?\nThe several States may regulate...';
    const start = content.indexOf('The several States');
    const end = start + 'The several States may regulate'.length;

    const result = extractContext(content, start, end);

    // Bug was: prefix = "nited States Senator?\nThe "
    // Fixed: prefix should include complete "United States Senator?\n" (and more context)
    expect(result.prefix).toBe('Who is a United States Senator?\n');
    expect(result.prefix).not.toMatch(/^nited/); // Should NOT start with "nited"
    expect(result.prefix).toContain('United States Senator?\n');
  });

  it('should handle newlines and tabs as boundaries', () => {
    const content = 'Line one\nLine two\tTabbed text here';
    const start = content.indexOf('Line two');
    const end = start + 'Line two'.length;

    const result = extractContext(content, start, end);

    // Should include previous line, extended to word boundary
    expect(result.prefix).toBe('Line one\n');
    expect(result.suffix).toBe('\tTabbed text here');
  });

  it('should handle quotes and apostrophes as boundaries', () => {
    const content = 'He said "The quick brown fox" runs fast';
    const start = content.indexOf('The quick brown fox');
    const end = start + 'The quick brown fox'.length;

    const result = extractContext(content, start, end);

    // Should include context before quote, extended to word boundary
    expect(result.prefix).toBe('He said "');
    expect(result.suffix).toBe('" runs fast');
  });

  it('should extract full context when selection is small', () => {
    const content = 'A short text with selected word here and more context around it';
    const start = content.indexOf('selected');
    const end = start + 'selected'.length;

    const result = extractContext(content, start, end);

    // Should extend to boundaries on both sides
    expect(result.prefix).toBe('A short text with ');
    expect(result.suffix).toBe(' word here and more context around it');
  });
});
