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
export declare function extractCharset(mediaType: string): string;
/**
 * Decode ArrayBuffer to string using charset from mediaType
 *
 * Uses TextDecoder with the charset extracted from mediaType parameter.
 * This ensures the same character space is used for both annotation creation
 * (gateway) and rendering (frontend).
 *
 * @param buffer - Binary data to decode
 * @param mediaType - Media type with optional charset parameter
 * @returns Decoded string in the original character space
 *
 * @example
 * const buffer = new Uint8Array([...]);
 * const text = decodeWithCharset(buffer, "text/plain; charset=iso-8859-1");
 */
export declare function decodeWithCharset(buffer: ArrayBuffer, mediaType: string): string;
