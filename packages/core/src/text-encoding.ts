/**
 * Text encoding utilities for consistent charset handling
 *
 * Ensures frontend decoding matches gateway decoding by respecting
 * charset parameters in mediaType (e.g., "text/plain; charset=iso-8859-1")
 */

/**
 * Extract charset from mediaType parameter
 *
 * @param mediaType - Media type with optional charset (e.g., "text/plain; charset=utf-8")
 * @returns Charset name in lowercase (defaults to "utf-8")
 *
 * @example
 * extractCharset("text/plain; charset=iso-8859-1") // "iso-8859-1"
 * extractCharset("text/plain") // "utf-8"
 */
export function extractCharset(mediaType: string): string {
  const charsetMatch = mediaType.match(/charset=([^\s;]+)/i);
  return (charsetMatch?.[1] || 'utf-8').toLowerCase();
}

/**
 * Decode bytes to a string using the charset from mediaType.
 *
 * The one place TypeScript turns a resource's bytes into its text
 * (specs/src/text/decode-cases.json states the rule every language's reader
 * keeps): the charset the media type states, UTF-8 when it states none; a
 * leading byte-order mark is not part of the text; a charset that is not
 * decoded is refused. Every reader sees the same text, so an offset counted
 * in one is the same place in another.
 *
 * @param buffer - Binary data to decode
 * @param mediaType - Media type with optional charset parameter
 * @returns Decoded string in the original character space
 *
 * @example
 * const buffer = new Uint8Array([...]);
 * const text = decodeWithCharset(buffer, "text/plain; charset=iso-8859-1");
 */
export function decodeWithCharset(buffer: ArrayBuffer | Uint8Array, mediaType: string): string {
  const charset = extractCharset(mediaType);

  // TextDecoder supports standard charset names
  // Common mappings that work in browsers:
  // - utf-8, utf-16, utf-16le, utf-16be
  // - iso-8859-1 through iso-8859-15
  // - windows-1252, windows-1251, etc.
  const decoder = new TextDecoder(charset);
  return decoder.decode(buffer);
}
