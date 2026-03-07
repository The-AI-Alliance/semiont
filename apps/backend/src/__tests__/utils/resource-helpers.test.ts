/**
 * Resource Helper Charset Tests
 *
 * Tests charset handling to prevent annotation offset bugs.
 * Ensures entity detection and content serving use the same encoding.
 */

import { describe, it, expect } from 'vitest';
import { getNodeEncoding, decodeRepresentation } from '@semiont/api-client';

describe('Resource Helpers - Charset Handling', () => {
  describe('getNodeEncoding', () => {
    it('should map UTF-8 variants correctly', () => {
      expect(getNodeEncoding('UTF-8')).toBe('utf8');
      expect(getNodeEncoding('utf-8')).toBe('utf8');
      expect(getNodeEncoding('utf8')).toBe('utf8');
      expect(getNodeEncoding('UTF8')).toBe('utf8');
    });

    it('should map ISO-8859-1 (Latin-1) variants correctly', () => {
      expect(getNodeEncoding('ISO-8859-1')).toBe('latin1');
      expect(getNodeEncoding('iso-8859-1')).toBe('latin1');
      expect(getNodeEncoding('latin1')).toBe('latin1');
      expect(getNodeEncoding('LATIN1')).toBe('latin1');
    });

    it('should map Windows-1252 to latin1', () => {
      expect(getNodeEncoding('windows-1252')).toBe('latin1');
      expect(getNodeEncoding('Windows-1252')).toBe('latin1');
      expect(getNodeEncoding('cp1252')).toBe('latin1');
      expect(getNodeEncoding('CP1252')).toBe('latin1');
    });

    it('should map ASCII variants correctly', () => {
      expect(getNodeEncoding('ASCII')).toBe('ascii');
      expect(getNodeEncoding('ascii')).toBe('ascii');
      expect(getNodeEncoding('US-ASCII')).toBe('ascii');
      expect(getNodeEncoding('us-ascii')).toBe('ascii');
    });

    it('should map UTF-16LE variants correctly', () => {
      expect(getNodeEncoding('UTF-16LE')).toBe('utf16le');
      expect(getNodeEncoding('utf-16le')).toBe('utf16le');
      expect(getNodeEncoding('utf16le')).toBe('utf16le');
    });

    it('should map UCS-2 variants correctly', () => {
      expect(getNodeEncoding('UCS-2')).toBe('ucs2');
      expect(getNodeEncoding('ucs-2')).toBe('ucs2');
      expect(getNodeEncoding('ucs2')).toBe('ucs2');
    });

    it('should handle binary encoding', () => {
      expect(getNodeEncoding('binary')).toBe('binary');
      expect(getNodeEncoding('BINARY')).toBe('binary');
    });

    it('should default to utf8 for unknown charsets', () => {
      expect(getNodeEncoding('unknown')).toBe('utf8');
      expect(getNodeEncoding('ISO-8859-15')).toBe('utf8');
      expect(getNodeEncoding('Big5')).toBe('utf8');
    });

    it('should handle charset names with hyphens and underscores', () => {
      expect(getNodeEncoding('UTF_8')).toBe('utf8');
      expect(getNodeEncoding('ISO_8859_1')).toBe('latin1');
      expect(getNodeEncoding('us_ascii')).toBe('ascii');
    });
  });

  describe('decodeRepresentation', () => {
    it('should decode UTF-8 text correctly', () => {
      const text = 'Hello, World! 你好世界';
      const buffer = Buffer.from(text, 'utf8');
      const decoded = decodeRepresentation(buffer, 'text/plain; charset=utf-8');
      expect(decoded).toBe(text);
    });

    it('should decode UTF-8 text without explicit charset', () => {
      const text = 'Hello, World!';
      const buffer = Buffer.from(text, 'utf8');
      const decoded = decodeRepresentation(buffer, 'text/plain');
      expect(decoded).toBe(text);
    });

    it('should decode ISO-8859-1 (Latin-1) text correctly', () => {
      // Text with extended Latin-1 characters (à, é, ñ, ü)
      const text = 'Café à Paris, Señor Müller';
      const buffer = Buffer.from(text, 'latin1');
      const decoded = decodeRepresentation(buffer, 'text/plain; charset=iso-8859-1');
      expect(decoded).toBe(text);
    });

    it('should decode Windows-1252 text correctly', () => {
      // Windows-1252 includes smart quotes and other characters
      // Note: Node.js doesn't have native Windows-1252 support, maps to latin1
      // This test verifies the mapping works for characters in ISO-8859-1 subset
      const text = 'Smart "quotes" and dashes';
      const buffer = Buffer.from(text, 'latin1');
      const decoded = decodeRepresentation(buffer, 'text/plain; charset=windows-1252');
      expect(decoded).toBe(text);
    });

    it('should decode ASCII text correctly', () => {
      const text = 'Plain ASCII text 123';
      const buffer = Buffer.from(text, 'ascii');
      const decoded = decodeRepresentation(buffer, 'text/plain; charset=us-ascii');
      expect(decoded).toBe(text);
    });

    it('should handle mediaType without charset parameter', () => {
      const text = 'Hello, World!';
      const buffer = Buffer.from(text, 'utf8');
      const decoded = decodeRepresentation(buffer, 'text/markdown');
      expect(decoded).toBe(text);
    });

    it('should handle mediaType with multiple parameters', () => {
      const text = 'Hello, World!';
      const buffer = Buffer.from(text, 'latin1');
      const decoded = decodeRepresentation(buffer, 'text/plain; charset=iso-8859-1; boundary=something');
      expect(decoded).toBe(text);
    });

    it('should be case-insensitive for charset parameter', () => {
      const text = 'Café';
      const buffer = Buffer.from(text, 'latin1');
      const decoded1 = decodeRepresentation(buffer, 'text/plain; CHARSET=ISO-8859-1');
      const decoded2 = decodeRepresentation(buffer, 'text/plain; Charset=iso-8859-1');
      expect(decoded1).toBe(text);
      expect(decoded2).toBe(text);
    });

    /**
     * REGRESSION TEST: Charset affects string length and character offsets
     *
     * This is the core bug we're preventing:
     * - If entity detection uses UTF-8 but frontend uses ISO-8859-1, offsets will be wrong
     * - Characters like é are 1 byte in ISO-8859-1 but 2 bytes in UTF-8
     */
    describe('Charset Offset Regression', () => {
      it('should maintain correct offsets with ISO-8859-1 extended characters', () => {
        // Text with extended Latin-1 characters that would have different byte lengths in UTF-8
        const text = 'The café is on the résumé of Señor López';
        const buffer = Buffer.from(text, 'latin1');

        // Decode with correct charset
        const decoded = decodeRepresentation(buffer, 'text/plain; charset=iso-8859-1');

        // Verify character offsets match
        expect(decoded.indexOf('café')).toBe(4);
        expect(decoded.indexOf('résumé')).toBe(19);
        expect(decoded.indexOf('Señor')).toBe(29);
        expect(decoded.indexOf('López')).toBe(35);

        // Verify substring extraction works correctly
        const cafeOffset = decoded.indexOf('café');
        expect(decoded.substring(cafeOffset, cafeOffset + 4)).toBe('café');

        const resumeOffset = decoded.indexOf('résumé');
        expect(decoded.substring(resumeOffset, resumeOffset + 6)).toBe('résumé');
      });

      it('should maintain correct offsets with UTF-8 multibyte characters', () => {
        const text = 'Hello 世界 你好';
        const buffer = Buffer.from(text, 'utf8');

        const decoded = decodeRepresentation(buffer, 'text/plain; charset=utf-8');

        // Verify character offsets
        expect(decoded.indexOf('世界')).toBe(6);
        expect(decoded.indexOf('你好')).toBe(9);

        // Verify substring extraction
        const worldOffset = decoded.indexOf('世界');
        expect(decoded.substring(worldOffset, worldOffset + 2)).toBe('世界');
      });

      it('should produce consistent offsets when charset matches buffer encoding', () => {
        const variants = [
          { text: 'Café à Paris', encoding: 'latin1' as BufferEncoding, mediaType: 'text/plain; charset=iso-8859-1' },
          { text: 'Hello 世界', encoding: 'utf8' as BufferEncoding, mediaType: 'text/plain; charset=utf-8' },
          { text: 'Simple ASCII', encoding: 'ascii' as BufferEncoding, mediaType: 'text/plain; charset=us-ascii' },
        ];

        for (const { text, encoding, mediaType } of variants) {
          const buffer = Buffer.from(text, encoding);
          const decoded = decodeRepresentation(buffer, mediaType);

          // The decoded string should match the original exactly
          expect(decoded).toBe(text);

          // And all character offsets should be preserved
          for (let i = 0; i < text.length; i++) {
            expect(decoded[i]).toBe(text[i]);
          }
        }
      });

      /**
       * Critical test: Simulates the real-world annotation offset bug
       *
       * If entity detection and content serving use different charsets,
       * the offsets will point to wrong positions in the text.
       */
      it('should prevent offset mismatch between entity detection and content serving', () => {
        // Simulate a resource with ISO-8859-1 encoding
        const originalText = 'The résumé mentions café in París';
        const mediaType = 'text/plain; charset=iso-8859-1';
        const buffer = Buffer.from(originalText, 'latin1');

        // Entity detection: should use decodeRepresentation
        const detectionText = decodeRepresentation(buffer, mediaType);

        // Content serving: should use decodeRepresentation
        const servingText = decodeRepresentation(buffer, mediaType);

        // Both should produce identical text
        expect(detectionText).toBe(servingText);

        // Find entity "café" in detection
        const entityStart = detectionText.indexOf('café');
        const entityEnd = entityStart + 4;
        const extractedEntity = detectionText.substring(entityStart, entityEnd);

        // Verify the entity matches when extracted from serving text at same offsets
        const verifyEntity = servingText.substring(entityStart, entityEnd);
        expect(verifyEntity).toBe('café');
        expect(verifyEntity).toBe(extractedEntity);

        // Same test for "París"
        const parisStart = detectionText.indexOf('París');
        const parisEnd = parisStart + 5;
        expect(detectionText.substring(parisStart, parisEnd)).toBe('París');
        expect(servingText.substring(parisStart, parisEnd)).toBe('París');
      });

      /**
       * This test demonstrates what would happen if we used wrong charset
       * (This should be impossible now with shared decodeRepresentation)
       */
      it('should demonstrate the bug that happens with charset mismatch', () => {
        const originalText = 'café';
        const buffer = Buffer.from(originalText, 'latin1');

        // Correct: using ISO-8859-1
        const correctDecode = buffer.toString('latin1');
        expect(correctDecode).toBe('café');
        expect(correctDecode.length).toBe(4);

        // Wrong: using UTF-8 on ISO-8859-1 data produces mojibake
        const wrongDecode = buffer.toString('utf8');
        expect(wrongDecode).not.toBe('café');
        // The é (0xE9 in Latin-1) becomes replacement character in UTF-8
        // Node.js replaces invalid UTF-8 bytes with U+FFFD (�)
        expect(wrongDecode).toContain('\uFFFD');

        // This demonstrates why shared charset handling is critical
        // Without it, users would see � instead of é
      });
    });
  });
});
