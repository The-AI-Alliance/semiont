import { describe, test, expect } from 'vitest';
import { extractCharset, decodeWithCharset } from '../text-encoding';

// What text a resource's bytes are is decode-cases.test.ts's, by the two
// tables every reader runs. Here is what those cannot reach: the charset
// `extractCharset` answers with, and the two forms bytes are handed over in.

describe('extractCharset', () => {
  test('the charset a media type states', () => {
    expect(extractCharset('text/plain; charset=iso-8859-1')).toBe('iso-8859-1');
    expect(extractCharset('text/plain;charset=windows-1252')).toBe('windows-1252');
  });

  test('in lower case, whatever case it and its name were stated in', () => {
    expect(extractCharset('text/plain; Charset=UTF-8')).toBe('utf-8');
  });

  test('without its quotation marks, and without the white space around it', () => {
    expect(extractCharset('text/plain; charset=" UTF-16LE "')).toBe('utf-16le');
  });

  test('utf-8 when none is stated, and when the one stated is empty', () => {
    expect(extractCharset('text/plain')).toBe('utf-8');
    expect(extractCharset('text/plain; charset=""')).toBe('utf-8');
    expect(extractCharset('not a media type; charset=iso-8859-1')).toBe('utf-8');
  });
});

describe('decodeWithCharset', () => {
  // "é" in UTF-16LE behind its mark, stated as UTF-8: the mark decides.
  const bytes = new Uint8Array([0xff, 0xfe, 0xe9, 0x00]);

  test('reads an ArrayBuffer as it reads the same bytes in a view', () => {
    expect(decodeWithCharset(bytes, 'text/plain; charset=utf-8')).toBe('é');
    expect(decodeWithCharset(bytes.buffer, 'text/plain; charset=utf-8')).toBe('é');
  });

  test('reads a view that is part of a larger buffer from where the view starts', () => {
    const larger = new Uint8Array([0x41, 0x42, ...bytes, 0x43]);
    expect(decodeWithCharset(larger.subarray(2, 6), 'text/plain')).toBe('é');
  });
});
