/**
 * What text a resource's bytes are, held to specs/src/text/decode-cases.json:
 * the table every reader of a resource's text runs.
 *
 * TypeScript has two readers, and each runs every case. `decodeWithCharset`
 * is the TypeScript SDK's and the Browser's. `decodeRepresentation` is the
 * Node services', and reads only a media type whose bytes are its text, which
 * every case's is.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeRepresentation } from '../resource-utils';
import { decodeWithCharset } from '../text-encoding';

interface Case { why: string; contentType: string; bytes: string; text?: string; refused?: true }

const TABLE = 'specs/src/text/decode-cases.json';
const table: { cases: Case[] } = JSON.parse(readFileSync(resolve(__dirname, '../../../..', TABLE), 'utf8'));

/** The bytes a case writes in hexadecimal, two digits to a byte. */
function bytesOf(hexadecimal: string): Buffer {
  const digits = hexadecimal.replaceAll(' ', '');
  const bytes = Buffer.from(digits, 'hex');
  if (bytes.length * 2 !== digits.length) throw new Error(`"${hexadecimal}" is not bytes in hexadecimal`);
  return bytes;
}

/** The same bytes as an `ArrayBuffer` of their own, as a content transport hands them over. */
function arrayBufferOf(bytes: Buffer): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const READERS: Record<string, (bytes: Buffer, contentType: string) => string> = {
  decodeWithCharset: (bytes, contentType) => decodeWithCharset(arrayBufferOf(bytes), contentType),
  decodeRepresentation,
};

describe('what text a resource\'s bytes are (specs/src/text/decode-cases.json)', () => {
  it('has cases of a text and of a refusal, and each case is one or the other', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(19);
    for (const stated of table.cases) {
      expect(typeof stated.text === 'string' ? stated.refused === undefined : stated.refused === true, stated.why).toBe(true);
    }
    expect(table.cases.some((stated) => typeof stated.text === 'string')).toBe(true);
    expect(table.cases.some((stated) => stated.refused === true)).toBe(true);
  });

  describe.each(Object.entries(READERS))('%s', (_name, read) => {
    it.each(table.cases)('$why', ({ contentType, bytes, text }) => {
      if (text === undefined) {
        expect(() => read(bytesOf(bytes), contentType)).toThrow();
      } else {
        expect(read(bytesOf(bytes), contentType)).toBe(text);
      }
    });
  });
});
