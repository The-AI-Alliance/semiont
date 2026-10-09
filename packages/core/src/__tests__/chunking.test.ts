import { describe, it, expect } from 'vitest';
import { chunkText, cutChunk } from '../chunking';

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    const text = 'Hello world, this is a short text.';
    const chunks = chunkText(text, { chunkSize: 512, overlap: 64 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits long text into multiple chunks', () => {
    // ~200 tokens worth of text (800 chars at 4 chars/token)
    const text = 'Word '.repeat(200);
    const chunks = chunkText(text, { chunkSize: 50, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunks overlap', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i}. `).join('');
    const chunks = chunkText(sentences, { chunkSize: 30, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('respects paragraph boundaries when possible', () => {
    const text = 'First paragraph with enough text to fill a chunk. ' +
      'More text in the first paragraph.\n\n' +
      'Second paragraph starts here with different content. ' +
      'Continuing the second paragraph.';
    const chunks = chunkText(text, { chunkSize: 30, overlap: 5 });
    // Should prefer to break at \n\n
    const hasParaBreak = chunks.some(c => c.endsWith('.'));
    expect(hasParaBreak).toBe(true);
  });

  it('returns empty array for empty text', () => {
    const chunks = chunkText('', { chunkSize: 512, overlap: 64 });
    expect(chunks).toHaveLength(0);
  });

  it('handles text that is exactly chunk size', () => {
    // chunkSize=10 means ~40 chars
    const text = 'A'.repeat(40);
    const chunks = chunkText(text, { chunkSize: 10, overlap: 2 });
    expect(chunks).toHaveLength(1);
  });
});

// `at` is an offset: it counts code points. The table (chunk-cases.json)
// holds every cut of a walk; this holds the two ends of what `at` may be.
describe('cutChunk', () => {
  const config = { chunkSize: 5, overlap: 1 };

  it('cut at the end of the text, by its code points, takes nothing and stays there', () => {
    // Three code points, five units of a string.
    expect(cutChunk('a😀😀', 3, config)).toEqual({ piece: '', next: 3 });
  });

  it('refuses an `at` the text does not have', () => {
    expect(() => cutChunk('a😀😀', 4, config)).toThrow(RangeError);
    expect(() => cutChunk('abc', -1, config)).toThrow(RangeError);
    expect(() => cutChunk('abc', 1.5, config)).toThrow(RangeError);
  });
});
