/**
 * What text a resource's bytes are, held to the two tables every reader of a
 * resource's text runs. specs/src/text/decode-cases.json is written by hand:
 * what is said of a content type, of a label, of a byte-order mark and of
 * malformed UTF-8 and UTF-16. specs/src/text/encoding-cases.json is
 * generated: every label of the Encoding Standard, and every byte of each of
 * its single-byte encodings.
 *
 * `decodeWithCharset` is the one reader TypeScript has: the SDK's, the
 * Browser's and, through `decodeRepresentation`, the Node services'.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SemiontError } from '../errors';
import { decodeWithCharset } from '../text-encoding';

interface Case { why: string; contentType: string; bytes: string; text?: string; refused?: string }
interface EncodingCase { encoding: string; labels: string[]; everyByte?: string; bytes?: string; text?: string; refused?: true }

const DECODE = 'specs/src/text/decode-cases.json';
const ENCODINGS = 'specs/src/text/encoding-cases.json';
const decode: { cases: Case[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../..', DECODE), 'utf8'));
const encodings: { cases: EncodingCase[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../..', ENCODINGS), 'utf8'));

const EVERY_BYTE = Uint8Array.from({ length: 256 }, (_, byte) => byte);

/** The bytes a case writes in hexadecimal, two digits to a byte. */
function bytesOf(hexadecimal: string): Uint8Array {
  const digits = hexadecimal.replaceAll(' ', '');
  const bytes = Buffer.from(digits, 'hex');
  if (bytes.length * 2 !== digits.length) throw new Error(`"${hexadecimal}" is not bytes in hexadecimal`);
  return bytes;
}

/** The reading is refused as the reader's own failure, and the refusal names the label. */
function refused(reading: () => string, label: string): void {
  let refusal: unknown;
  try {
    refusal = `read as ${JSON.stringify(reading())}`;
  } catch (error) {
    refusal = error;
  }
  if (!(refusal instanceof SemiontError)) throw new Error(`not refused as the reader's own failure: ${String(refusal)}`);
  expect(refusal.code).toBe('error');
  expect(refusal.message).toContain(label);
}

describe('what text a resource\'s bytes are (specs/src/text/decode-cases.json)', () => {
  it('has cases of a text and of a refusal, and each case is one or the other', () => {
    expect(decode.cases.length).toBeGreaterThanOrEqual(90);
    for (const stated of decode.cases) {
      expect(typeof stated.text === 'string' ? stated.refused === undefined : typeof stated.refused === 'string', stated.why).toBe(true);
    }
    expect(decode.cases.some((stated) => typeof stated.text === 'string')).toBe(true);
    expect(decode.cases.some((stated) => typeof stated.refused === 'string')).toBe(true);
  });

  it.each(decode.cases)('$why', ({ contentType, bytes, text, refused: label }) => {
    if (text !== undefined) {
      expect(decodeWithCharset(bytesOf(bytes), contentType)).toBe(text);
    } else if (label !== undefined) {
      refused(() => decodeWithCharset(bytesOf(bytes), contentType), label);
    } else {
      throw new Error('the case states neither its text nor that it is refused');
    }
  });
});

describe('every label of the Encoding Standard, and every byte of its single-byte encodings (specs/src/text/encoding-cases.json)', () => {
  it('has cases of each kind', () => {
    expect(encodings.cases.filter((stated) => stated.everyByte !== undefined).length).toBeGreaterThanOrEqual(29);
    expect(encodings.cases.some((stated) => stated.text !== undefined)).toBe(true);
    expect(encodings.cases.some((stated) => stated.refused === true)).toBe(true);
  });

  describe.each(encodings.cases)('$encoding', ({ labels, everyByte, bytes, text, refused: everyLabel }) => {
    it.each(labels)('%s', (label) => {
      const contentType = `text/plain; charset=${label}`;
      if (everyByte !== undefined) {
        expect(decodeWithCharset(EVERY_BYTE, contentType)).toBe(everyByte);
      } else if (bytes !== undefined && text !== undefined) {
        expect(decodeWithCharset(bytesOf(bytes), contentType)).toBe(text);
      } else if (everyLabel === true) {
        refused(() => decodeWithCharset(EVERY_BYTE, contentType), label);
      } else {
        throw new Error('the case is of no kind this runner knows');
      }
    });
  });
});
