import { describe, it, expect } from 'vitest';
import { extractContext, validateAndCorrectOffsets } from '../text-context';

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

describe('validateAndCorrectOffsets - AI Offset Validation', () => {
  it('should return AI offsets when they are correct', () => {
    const content = 'The quick brown fox jumps over the lazy dog';
    const exact = 'quick brown fox';
    const start = content.indexOf(exact);
    const end = start + exact.length;

    const result = validateAndCorrectOffsets(content, start, end, exact);

    expect(result.start).toBe(start);
    expect(result.end).toBe(end);
    expect(result.exact).toBe(exact);
    expect(result.corrected).toBe(false);
    expect(result.matchQuality).toBe('exact');
    expect(result.fuzzyMatched).toBeUndefined();
    expect(result.prefix).toBe('The ');
    expect(result.suffix).toBe(' jumps over the lazy dog');
  });

  it('should correct offsets when AI provides wrong position', () => {
    const content = 'The quick brown fox jumps over the lazy dog';
    const exact = 'brown fox';
    const correctStart = content.indexOf(exact); // 10
    const correctEnd = correctStart + exact.length; // 19

    // Simulate AI providing wrong offsets (off by 5)
    const wrongStart = 5;
    const wrongEnd = 14;

    const result = validateAndCorrectOffsets(content, wrongStart, wrongEnd, exact);

    expect(result.start).toBe(correctStart);
    expect(result.end).toBe(correctEnd);
    expect(result.exact).toBe(exact);
    expect(result.corrected).toBe(true);
    expect(result.matchQuality).toBe('exact');
    expect(result.fuzzyMatched).toBe(false);
    expect(result.prefix).toBe('The quick ');
    expect(result.suffix).toBe(' jumps over the lazy dog');
  });

  it('should reproduce the real-world bug case from tagging annotation', () => {
    // The actual content from the legal document
    const content = 'J., who reserved and transferred without ruling, on an agreed statement of facts, the question "whether the plaintiff has jurisdiction over and can sue B 8c L Liquidating Corporation, which was dissolved on January 21,1969."';

    const exact = 'the question "whether the plaintiff has jurisdiction over and can sue B 8c L Liquidating Corporation, which was dissolved on January 21,1969."';

    // AI said these offsets (but they're wrong)
    const aiStart = 1143 - 1049; // Adjusted for shorter test string (original was in full document)
    const aiEnd = 1289 - 1049;

    // Find where the text actually is
    const correctStart = content.indexOf(exact);
    const correctEnd = correctStart + exact.length;

    const result = validateAndCorrectOffsets(content, aiStart, aiEnd, exact);

    // Should correct to actual position
    expect(result.start).toBe(correctStart);
    expect(result.end).toBe(correctEnd);
    expect(result.exact).toBe(exact);
    expect(result.corrected).toBe(true);

    // Verify extracted text matches
    expect(content.substring(result.start, result.end)).toBe(exact);

    // Prefix/suffix should be at word boundaries (truncated to CONTEXT_LENGTH=64)
    expect(result.prefix).toBe('and transferred without ruling, on an agreed statement of facts, ');
    expect(result.suffix).toBeUndefined(); // At end of content
  });

  it('should throw error if exact text cannot be found', () => {
    const content = 'The quick brown fox jumps over the lazy dog';
    const exact = 'purple elephant'; // Not in content
    const aiStart = 0;
    const aiEnd = 15;

    expect(() => {
      validateAndCorrectOffsets(content, aiStart, aiEnd, exact);
    }).toThrow('Cannot find acceptable match');
  });

  it('should handle exact text appearing multiple times (finds first occurrence)', () => {
    const content = 'The dog chased the dog chased the dog';
    const exact = 'the dog';
    const aiStart = 20; // AI points to second occurrence
    const aiEnd = 27;

    const result = validateAndCorrectOffsets(content, aiStart, aiEnd, exact);

    // Should find first occurrence
    expect(result.start).toBe(15); // First "the dog" (case-insensitive search returns lowercase)
    expect(result.end).toBe(22);
    expect(result.corrected).toBe(true);
  });

  it('should extract proper word-boundary context after correction', () => {
    const content = 'Who is a United States Senator?\nThe several States may regulate elections';
    const exact = 'The several States';

    // AI gives wrong offset (points into middle of word)
    const aiStart = 28; // Points to "tor?\nThe"
    const aiEnd = 46;

    const result = validateAndCorrectOffsets(content, aiStart, aiEnd, exact);

    // Should correct and extract proper context
    const correctStart = content.indexOf(exact);
    expect(result.start).toBe(correctStart);
    expect(result.exact).toBe(exact);
    expect(result.corrected).toBe(true);

    // Prefix should end at word boundary (after "?\n")
    expect(result.prefix).toBe('Who is a United States Senator?\n');

    // Suffix should start at word boundary
    expect(result.suffix).toBe(' may regulate elections');
  });

  it('should handle offsets in middle of multibyte characters correctly', () => {
    const content = 'café résumé naïve';
    const exact = 'résumé';
    const correctStart = content.indexOf(exact);
    const correctEnd = correctStart + exact.length;

    // AI might give byte offsets instead of character offsets
    const result = validateAndCorrectOffsets(content, correctStart, correctEnd, exact);

    expect(result.start).toBe(correctStart);
    expect(result.end).toBe(correctEnd);
    expect(result.corrected).toBe(false);
    expect(content.substring(result.start, result.end)).toBe(exact);
  });

  it('should handle case-insensitive match when exact case differs', () => {
    const content = 'The Quick Brown Fox jumps over the lazy dog';
    const exact = 'quick brown fox'; // AI provided lowercase
    const wrongStart = 0;
    const wrongEnd = 15;

    const result = validateAndCorrectOffsets(content, wrongStart, wrongEnd, exact);

    // Should find "Quick Brown Fox" despite case difference
    expect(result.corrected).toBe(true);
    expect(result.matchQuality).toBe('case-insensitive');
    expect(result.fuzzyMatched).toBe(true);
    expect(result.exact).toBe('Quick Brown Fox'); // Uses document version
    expect(result.start).toBe(4);
    expect(result.end).toBe(19);
  });

  it('should handle fuzzy match with minor typos', () => {
    const content = 'The plaintiff has jurisdiction over the defendant';
    const exact = 'The plaintif has juridiction over the defenda'; // AI made typos
    const wrongStart = 0;
    const wrongEnd = exact.length; // 45 chars

    const result = validateAndCorrectOffsets(content, wrongStart, wrongEnd, exact);

    // Should find close match using Levenshtein distance (4 char difference)
    expect(result.corrected).toBe(true);
    expect(result.matchQuality).toBe('fuzzy');
    expect(result.fuzzyMatched).toBe(true);
    // Fuzzy match uses same length as input (sliding window)
    expect(result.exact.length).toBe(exact.length);
    expect(result.exact).toBe('The plaintiff has jurisdiction over the defen'); // Document version at same position/length
    expect(result.start).toBe(0);
  });

  it('should handle fuzzy match within tolerance threshold', () => {
    // Test 5% tolerance - 10 char string allows 1-2 char difference
    const content = 'Hello world from the test suite';
    const exact = 'Hello word'; // AI says "word" instead of "world"
    const wrongStart = 0;
    const wrongEnd = 10;

    const result = validateAndCorrectOffsets(content, wrongStart, wrongEnd, exact);

    // Should find "Hello worl" or similar close match
    expect(result.corrected).toBe(true);
    expect(result.fuzzyMatched).toBe(true);
    expect(['fuzzy', 'exact']).toContain(result.matchQuality);
  });

  it('should throw on text that is too different (exceeds fuzzy threshold)', () => {
    const content = 'The quick brown fox jumps over the lazy dog';
    const exact = 'Completely different and unrelated text goes here now'; // Totally different, longer
    const wrongStart = 0;
    const wrongEnd = exact.length;

    expect(() => {
      validateAndCorrectOffsets(content, wrongStart, wrongEnd, exact);
    }).toThrow('Cannot find acceptable match');
  });

  it('should search near AI position first (fuzzy match)', () => {
    // When text with typos appears, fuzzy search finds the best match
    const content = 'Start: The slow cat. Middle: The quick fox is here. End: The lazy dog.';
    const exact = 'The quik fox'; // AI typo: "quik" instead of "quick" (12 chars)
    const aiStart = 30; // Points near middle section where "The quick fox" appears
    const aiEnd = aiStart + exact.length;

    const result = validateAndCorrectOffsets(content, aiStart, aiEnd, exact);

    // Should find fuzzy match for 12-char window
    expect(result.corrected).toBe(true);
    expect(result.fuzzyMatched).toBe(true);
    expect(result.matchQuality).toBe('fuzzy');
    // The result should be 12 characters (same length as input)
    expect(result.exact.length).toBe(12);
    // Should match part of "The quick fox"
    expect(result.start).toBeGreaterThanOrEqual(28);
    expect(result.start).toBeLessThanOrEqual(32);
  });
});
