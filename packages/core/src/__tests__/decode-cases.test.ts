/**
 * What text a resource's bytes are, held to the two tables every reader of a
 * resource's text runs. specs/src/text/decode-cases.json is written by hand:
 * what is said of a content type, of a label, of a byte-order mark, of
 * malformed UTF-8 and UTF-16, and of a media type whose text is not its
 * bytes. specs/src/text/encoding-cases.json is generated: every label of the
 * Encoding Standard, and every byte of each of its single-byte encodings.
 *
 * The first table is run through `decodeRepresentation`, which refuses a
 * media type whose text is not its bytes and reads every other with
 * `decodeWithCharset`: the one place TypeScript makes a text of bytes. The
 * second, whose every content type is text/plain, is run through
 * `decodeWithCharset` itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SemiontError } from '../errors';
import { textSourceOf } from '../media-types';
import { decodeRepresentation } from '../resource-utils';
import { decodeWithCharset } from '../text-encoding';

interface Case { why: string; contentType: string; bytes: string; text?: string; refused?: string }
interface EncodingCase { encoding: string; labels: string[]; everyByte?: string; bytes?: string; text?: string; refused?: true }

const DECODE = 'specs/src/text/decode-cases.json';
const ENCODINGS = 'specs/src/text/encoding-cases.json';
const decode: { cases: Case[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../..', DECODE), 'utf8'));
const encodings: { cases: EncodingCase[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../..', ENCODINGS), 'utf8'));

const EVERY_BYTE = Uint8Array.from({ length: 256 }, (_, byte) => byte);

/** The bytes a case writes in hexadecimal, two digits to a byte. */
function bytesOf(hexadecimal: string): Buffer {
  const digits = hexadecimal.replaceAll(' ', '');
  const bytes = Buffer.from(digits, 'hex');
  if (bytes.length * 2 !== digits.length) throw new Error(`"${hexadecimal}" is not bytes in hexadecimal`);
  return bytes;
}

/** The reading is refused as the reader's own failure, and the refusal names what it refuses: a label, or a media type. */
function refused(reading: () => string, named: string): void {
  let refusal: unknown;
  try {
    refusal = `read as ${JSON.stringify(reading())}`;
  } catch (error) {
    refusal = error;
  }
  if (!(refusal instanceof SemiontError)) throw new Error(`not refused as the reader's own failure: ${String(refusal)}`);
  expect(refusal.code).toBe('error');
  expect(refusal.message).toContain(named);
}

describe('what text a resource\'s bytes are (specs/src/text/decode-cases.json)', () => {
  it('has cases of a text and of a refusal, and each case is one or the other', () => {
    expect(decode.cases.length).toBeGreaterThanOrEqual(90);
    for (const stated of decode.cases) {
      expect(typeof stated.text === 'string' ? stated.refused === undefined : typeof stated.refused === 'string', stated.why).toBe(true);
    }
    expect(decode.cases.some((stated) => typeof stated.text === 'string')).toBe(true);
    expect(decode.cases.some((stated) => typeof stated.refused === 'string')).toBe(true);
    // A refusal is of a charset, where the media type is one that is decoded,
    // or of the media type: one whose text is derived, and one with none.
    const refusedOf = decode.cases.filter((stated) => stated.refused !== undefined).map((stated) => textSourceOf(stated.contentType));
    expect(Array.from(new Set(refusedOf)).sort()).toEqual(['decode', 'none', 'pdf-text-layer']);
  });

  it.each(decode.cases)('$why', ({ contentType, bytes, text, refused: named }) => {
    if (text !== undefined) {
      expect(decodeRepresentation(bytesOf(bytes), contentType)).toBe(text);
    } else if (named !== undefined) {
      refused(() => decodeRepresentation(bytesOf(bytes), contentType), named);
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
