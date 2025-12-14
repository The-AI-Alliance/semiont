import { describe, it, expect } from 'vitest';
import { extractContext } from '../text-context';

/**
 * Tests for extractContext function
 * Ensures prefix/suffix context extraction respects word boundaries
 */

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

  it('should reproduce the second bug case from reference annotation', () => {
    // Bug case: prefix/suffix truncated "products" to "produc"
    const content = 'the Company entered into an agreement to promote sales of Gurley products in the region';
    const start = content.indexOf('to promote sales of Gurley products');
    const end = start + 'to promote sales of Gurley products'.length;

    const result = extractContext(content, start, end);

    // Bug was: context extraction would cut "products" to "produc"
    // Fixed: should include complete words in prefix
    expect(result.prefix).toBe('the Company entered into an agreement ');
    expect(result.suffix).toBe(' in the region');
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

  it('should handle empty content', () => {
    const content = '';
    const start = 0;
    const end = 0;

    const result = extractContext(content, start, end);

    expect(result.prefix).toBeUndefined();
    expect(result.suffix).toBeUndefined();
  });

  it('should handle selection spanning entire content', () => {
    const content = 'Hello world';
    const start = 0;
    const end = content.length;

    const result = extractContext(content, start, end);

    expect(result.prefix).toBeUndefined();
    expect(result.suffix).toBeUndefined();
  });

  it('should handle multiple punctuation marks', () => {
    const content = 'Text... (with) [multiple] {punctuation} marks!!! here';
    const start = content.indexOf('multiple');
    const end = start + 'multiple'.length;

    const result = extractContext(content, start, end);

    expect(result.prefix).toContain('[');
    expect(result.suffix).toContain(']');
  });

  it('should handle forward slashes and backslashes', () => {
    const content = 'Path/to/file\\with\\backslashes and forward/slashes';
    const start = content.indexOf('with');
    const end = start + 'with'.length;

    const result = extractContext(content, start, end);

    expect(result.prefix).toContain('file\\');
    expect(result.suffix).toContain('\\backslashes');
  });
});
