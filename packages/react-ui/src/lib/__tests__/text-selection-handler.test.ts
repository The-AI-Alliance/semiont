import { describe, it, expect } from 'vitest';
import { textOffsets } from '@semiont/core';
import { buildTextSelectors, fallbackTextPosition } from '../text-selection-handler';

describe('buildTextSelectors', () => {
  const content = 'The quick brown fox jumps over the lazy dog';
  const offsets = textOffsets(content);

  it('returns TextPositionSelector + TextQuoteSelector pair', () => {
    const result = buildTextSelectors(content, offsets, 10, 19);
    expect(result).not.toBeNull();
    expect(result![0]).toEqual({ type: 'TextPositionSelector', start: 10, end: 19 });
    expect(result![1].type).toBe('TextQuoteSelector');
    expect(result![1].exact).toBe('brown fox');
  });

  it('includes the content around the selection as prefix and suffix', () => {
    const result = buildTextSelectors(content, offsets, 10, 19);
    expect(result![1].prefix).toBe('The quick ');
    expect(result![1].suffix).toBe(' jumps over the lazy dog');
  });

  it('omits prefix when at start of content', () => {
    const result = buildTextSelectors(content, offsets, 0, 3);
    expect(result![1].prefix).toBeUndefined();
    expect(result![1].suffix).toBe(' quick brown fox jumps over the lazy dog');
  });

  it('omits suffix when at end of content', () => {
    const result = buildTextSelectors(content, offsets, 40, 43);
    expect(result![1].prefix).toBe('The quick brown fox jumps over the lazy ');
    expect(result![1].suffix).toBeUndefined();
  });

  it('returns null for a selection of nothing', () => {
    expect(buildTextSelectors(content, offsets, 0, 0)).toBeNull();
  });

  it('returns null for negative start', () => {
    expect(buildTextSelectors(content, offsets, -1, 3)).toBeNull();
  });

  it('returns null for end <= start', () => {
    expect(buildTextSelectors(content, offsets, 5, 5)).toBeNull();
    expect(buildTextSelectors(content, offsets, 5, 3)).toBeNull();
  });

  it('returns null for end beyond content length', () => {
    expect(buildTextSelectors(content, offsets, 0, content.length + 1)).toBeNull();
  });
});

describe('fallbackTextPosition', () => {
  const firstPlaceOf = (content: string, selectedText: string) =>
    fallbackTextPosition(content, textOffsets(content), selectedText);

  it('returns position when text is found', () => {
    expect(firstPlaceOf('Hello world', 'world')).toEqual({ start: 6, end: 11 });
  });

  it('returns first occurrence for duplicate text', () => {
    expect(firstPlaceOf('abc abc abc', 'abc')).toEqual({ start: 0, end: 3 });
  });

  it('returns null when text is not found', () => {
    expect(firstPlaceOf('Hello world', 'xyz')).toBeNull();
  });

  it('returns position for text at start', () => {
    expect(firstPlaceOf('Hello', 'Hello')).toEqual({ start: 0, end: 5 });
  });

  it('finds an empty selected text at the start of an empty content', () => {
    // indexOf('') returns 0, so this returns a valid position
    expect(firstPlaceOf('', '')).toEqual({ start: 0, end: 0 });
  });
});
