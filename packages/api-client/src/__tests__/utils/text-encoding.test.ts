import { describe, test, expect } from 'vitest';
import { extractCharset, decodeWithCharset } from '../../utils/text-encoding';

describe('extractCharset', () => {
  test('extracts charset from media type', () => {
    expect(extractCharset('text/plain; charset=iso-8859-1')).toBe('iso-8859-1');
  });

  test('extracts charset case-insensitively', () => {
    expect(extractCharset('text/plain; Charset=UTF-8')).toBe('utf-8');
  });

  test('defaults to utf-8 when no charset', () => {
    expect(extractCharset('text/plain')).toBe('utf-8');
  });

  test('handles charset with no spaces', () => {
    expect(extractCharset('text/plain;charset=windows-1252')).toBe('windows-1252');
  });
});

describe('decodeWithCharset', () => {
  test('decodes utf-8 buffer', () => {
    const encoder = new TextEncoder();
    const buffer = encoder.encode('Hello World').buffer;
    expect(decodeWithCharset(buffer, 'text/plain; charset=utf-8')).toBe('Hello World');
  });

  test('decodes buffer with default charset', () => {
    const encoder = new TextEncoder();
    const buffer = encoder.encode('Test').buffer;
    expect(decodeWithCharset(buffer, 'text/plain')).toBe('Test');
  });

  test('decodes iso-8859-1 buffer', () => {
    // ISO-8859-1 byte for ü (0xFC)
    const buffer = new Uint8Array([0xFC]).buffer;
    expect(decodeWithCharset(buffer, 'text/plain; charset=iso-8859-1')).toBe('ü');
  });
});
