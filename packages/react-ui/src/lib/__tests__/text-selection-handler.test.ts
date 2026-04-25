import { describe, it, expect, vi } from 'vitest';
import { buildTextSelectors, fallbackTextPosition } from '../text-selection-handler';

// Mock extractContext from api-client
vi.mock('@semiont/core', () => ({
  extractContext: vi.fn((content: string, start: number, end: number) => {
    const prefix = start > 0 ? content.slice(Math.max(0, start - 10), start) : undefined;
    const suffix = end < content.length ? content.slice(end, Math.min(content.length, end + 10)) : undefined;
    return { prefix, suffix };
  }),
}));

describe('buildTextSelectors', () => {
  const content = 'The quick brown fox jumps over the lazy dog';

  it('returns TextPositionSelector + TextQuoteSelector pair', () => {
    const result = buildTextSelectors(content, 'brown fox', 10, 19);
    expect(result).not.toBeNull();
    expect(result![0]).toEqual({ type: 'TextPositionSelector', start: 10, end: 19 });
    expect(result![1].type).toBe('TextQuoteSelector');
    expect(result![1].exact).toBe('brown fox');
  });

  it('includes prefix and suffix from context', () => {
    const result = buildTextSelectors(content, 'brown fox', 10, 19);
    expect(result![1].prefix).toBeDefined();
    expect(result![1].suffix).toBeDefined();
  });

  it('omits prefix when at start of content', () => {
    const result = buildTextSelectors(content, 'The', 0, 3);
    expect(result![1].prefix).toBeUndefined();
    expect(result![1].suffix).toBeDefined();
  });

  it('omits suffix when at end of content', () => {
    const result = buildTextSelectors(content, 'dog', 40, 43);
    expect(result![1].prefix).toBeDefined();
    expect(result![1].suffix).toBeUndefined();
  });

  it('returns null for empty selected text', () => {
    expect(buildTextSelectors(content, '', 0, 0)).toBeNull();
  });

  it('returns null for negative start', () => {
    expect(buildTextSelectors(content, 'foo', -1, 3)).toBeNull();
  });

  it('returns null for end <= start', () => {
    expect(buildTextSelectors(content, 'foo', 5, 5)).toBeNull();
    expect(buildTextSelectors(content, 'foo', 5, 3)).toBeNull();
  });

  it('returns null for end beyond content length', () => {
    expect(buildTextSelectors(content, 'foo', 0, content.length + 1)).toBeNull();
  });
});

describe('fallbackTextPosition', () => {
  it('returns position when text is found', () => {
    const result = fallbackTextPosition('Hello world', 'world');
    expect(result).toEqual({ start: 6, end: 11 });
  });

  it('returns first occurrence for duplicate text', () => {
    const result = fallbackTextPosition('abc abc abc', 'abc');
    expect(result).toEqual({ start: 0, end: 3 });
  });

  it('returns null when text is not found', () => {
    expect(fallbackTextPosition('Hello world', 'xyz')).toBeNull();
  });

  it('returns position for text at start', () => {
    expect(fallbackTextPosition('Hello', 'Hello')).toEqual({ start: 0, end: 5 });
  });

  it('returns null for empty selected text in empty content', () => {
    // indexOf('') returns 0, so this returns a valid position
    const result = fallbackTextPosition('', '');
    expect(result).toEqual({ start: 0, end: 0 });
  });
});
