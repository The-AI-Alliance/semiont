/**
 * What text a resource's bytes are.
 *
 * The rule is protocol: docs/protocol/W3C-SELECTORS.md states it ("The text
 * of a resource"), and the two tables every reader runs hold it,
 * specs/src/text/decode-cases.json and specs/src/text/encoding-cases.json. It
 * is the MIME Sniffing Standard's reading of the content type and the
 * Encoding Standard's reading of the bytes, as a browser follows the two. An
 * offset counts the code points of this text, so every reader makes the same
 * text of the same bytes.
 *
 * The decoders are the platform's `TextDecoder`, which has the standard's
 * labels and its encodings. What it does not do is here: the content type's
 * parsing, the byte-order mark's deciding, and the refusal.
 */

import { SemiontError } from './errors';
import type { TransportErrorCode } from './generated/error-codes';

/** HTTP white space: line feed, carriage return, tab and space. */
const isHttpWhiteSpace = (character: string): boolean =>
  character === '\n' || character === '\r' || character === '\t' || character === ' ';
const withoutTrailingHttpWhiteSpace = (text: string): string => text.replace(/[\n\r\t ]+$/, '');

/** An HTTP token: what a type, a subtype and a parameter's name are made of. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** What a parameter's value may hold: a tab, U+0020 to U+007E, and U+0080 to U+00FF. */
const PARAMETER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

const asciiLowerCase = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The quoted string that opens at `start`, without its quotation marks, and where it ends. */
function quotedString(input: string, start: number): [value: string, end: number] {
  let position = start + 1;
  let value = '';
  for (;;) {
    const from = position;
    while (position < input.length && input.charAt(position) !== '"' && input.charAt(position) !== '\\') position += 1;
    value += input.slice(from, position);
    if (position >= input.length) break;
    const mark = input.charAt(position);
    position += 1;
    if (mark === '"') break;
    // A backslash gives the character after it, and at the very end is itself.
    if (position >= input.length) {
      value += '\\';
      break;
    }
    value += input.charAt(position);
    position += 1;
  }
  return [value, position];
}

/**
 * The value of a content type's `charset` parameter, as the MIME Sniffing
 * Standard parses a MIME type: the first parameter of that name that is one.
 * `undefined` where there is none, and where the content type is no MIME
 * type.
 */
function charsetParameter(contentType: string): string | undefined {
  const input = withoutTrailingHttpWhiteSpace(contentType.replace(/^[\n\r\t ]+/, ''));
  const slash = input.indexOf('/');
  if (slash === -1 || !HTTP_TOKEN.test(input.slice(0, slash))) return undefined;
  const semicolon = input.indexOf(';', slash);
  let position = semicolon === -1 ? input.length : semicolon;
  if (!HTTP_TOKEN.test(withoutTrailingHttpWhiteSpace(input.slice(slash + 1, position)))) return undefined;

  while (position < input.length) {
    position += 1; // past the semicolon
    while (position < input.length && isHttpWhiteSpace(input.charAt(position))) position += 1;
    const nameStart = position;
    while (position < input.length && input.charAt(position) !== ';' && input.charAt(position) !== '=') position += 1;
    const name = asciiLowerCase(input.slice(nameStart, position));
    if (position < input.length) {
      if (input.charAt(position) === ';') continue;
      position += 1; // past the equals sign
    }
    if (position >= input.length) break;

    let value: string;
    if (input.charAt(position) === '"') {
      [value, position] = quotedString(input, position);
      while (position < input.length && input.charAt(position) !== ';') position += 1;
    } else {
      const valueStart = position;
      while (position < input.length && input.charAt(position) !== ';') position += 1;
      value = withoutTrailingHttpWhiteSpace(input.slice(valueStart, position));
      if (value === '') continue;
    }
    if (name === 'charset' && PARAMETER_VALUE.test(value)) return value;
  }
  return undefined;
}

/**
 * The charset a media type states: its `charset` parameter as the MIME
 * Sniffing Standard parses a MIME type, in ASCII lower case and without the
 * ASCII white space around it. `utf-8` where it states none, or an empty
 * one.
 *
 * @example
 * extractCharset('text/plain; charset=ISO-8859-1') // 'iso-8859-1'
 * extractCharset('text/plain; charset="utf-16le"') // 'utf-16le'
 * extractCharset('text/plain') // 'utf-8'
 */
export function extractCharset(mediaType: string): string {
  const stated = charsetParameter(mediaType);
  if (stated === undefined || stated === '') return 'utf-8';
  return asciiLowerCase(stated.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''));
}

/** The platform's decoder for a label of the Encoding Standard, or the reader's own refusal, which names the label. */
function decoderFor(label: string): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch {
    throw new SemiontError(
      `The resource's text is ${label}, which is no charset this platform decodes: read its bytes instead`,
      'error' satisfies TransportErrorCode,
    );
  }
}

/** The encoding whose byte-order mark the bytes begin with. */
function encodingOfMark(bytes: Uint8Array): 'utf-8' | 'utf-16be' | 'utf-16le' | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return undefined;
}

/**
 * A resource's bytes as the text they are: the one place TypeScript makes a
 * text of a resource's bytes.
 *
 * The charset is the one the media type states, UTF-8 when it states none,
 * and is a label of the Encoding Standard: any other is refused, whatever the
 * bytes are. Bytes that begin with the byte-order mark of UTF-8, UTF-16BE or
 * UTF-16LE are in that encoding, whatever was stated, and the mark is not
 * part of the text. What the encoding does not have is U+FFFD.
 *
 * @param buffer - The bytes
 * @param mediaType - The content type they came with (e.g. "text/plain; charset=iso-8859-1")
 * @throws A `SemiontError` whose code is `error`, naming the charset, for one that is not decoded
 *
 * @example
 * const text = decodeWithCharset(bytes, "text/plain; charset=iso-8859-1");
 */
export function decodeWithCharset(buffer: ArrayBuffer | Uint8Array, mediaType: string): string {
  const bytes = ArrayBuffer.isView(buffer) ? buffer : new Uint8Array(buffer);
  // The stated charset is held to the standard before the bytes are looked at.
  const stated = decoderFor(extractCharset(mediaType));
  const marked = encodingOfMark(bytes);
  // A decoder leaves out the mark of its own encoding, and that is the one at the start here.
  return (marked === undefined ? stated : decoderFor(marked)).decode(bytes);
}
