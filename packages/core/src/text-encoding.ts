/**
 * Text encoding utilities for consistent charset handling
 *
 * Ensures frontend decoding matches backend decoding by respecting
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
 * Decode ArrayBuffer to string using charset from mediaType
 *
 * Uses TextDecoder with the charset extracted from mediaType parameter.
 * This ensures the same character space is used for both annotation creation
 * (backend) and rendering (frontend).
 *
 * @param buffer - Binary data to decode
 * @param mediaType - Media type with optional charset parameter
 * @returns Decoded string in the original character space
 *
 * @example
 * const buffer = new Uint8Array([...]);
 * const text = decodeWithCharset(buffer, "text/plain; charset=iso-8859-1");
 */
export function decodeWithCharset(buffer: ArrayBuffer, mediaType: string): string {
  const charset = extractCharset(mediaType);

  // TextDecoder supports standard charset names
  // Common mappings that work in browsers:
  // - utf-8, utf-16, utf-16le, utf-16be
  // - iso-8859-1 through iso-8859-15
  // - windows-1252, windows-1251, etc.
  const decoder = new TextDecoder(charset);
  return decoder.decode(buffer);
}
