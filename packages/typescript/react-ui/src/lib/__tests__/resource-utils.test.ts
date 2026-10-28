import { describe, it, expect } from 'vitest';
import { getResourceIcon, supportsDetection } from '../resource-utils';

describe('resource-utils', () => {
  describe('getResourceIcon', () => {
    describe('Image Types', () => {
      it('should return image icon for image/* media types', () => {
        const imageTypes = [
          'image/jpeg',
          'image/png',
          'image/gif',
          'image/webp',
          'image/svg+xml',
        ];

        imageTypes.forEach(type => {
          expect(getResourceIcon(type)).toBe('🖼️');
        });
      });

      it('should handle image/* with charset', () => {
        expect(getResourceIcon('image/jpeg; charset=utf-8')).toBe('🖼️');
      });

      it('should handle uppercase IMAGE/*', () => {
        expect(getResourceIcon('IMAGE/PNG')).toBe('🖼️');
      });
    });

    describe('Text Types', () => {
      it('should return markdown icon for text/markdown', () => {
        expect(getResourceIcon('text/markdown')).toBe('📝');
      });

      it('should return HTML icon for text/html', () => {
        expect(getResourceIcon('text/html')).toBe('🌐');
      });

      it('should return document icon for text/plain', () => {
        expect(getResourceIcon('text/plain')).toBe('📄');
      });

      it('should handle text types with charset', () => {
        expect(getResourceIcon('text/markdown; charset=utf-8')).toBe('📝');
        expect(getResourceIcon('text/html; charset=utf-8')).toBe('🌐');
        expect(getResourceIcon('text/plain; charset=utf-8')).toBe('📄');
      });

      it('should handle uppercase TEXT/ types', () => {
        expect(getResourceIcon('TEXT/MARKDOWN')).toBe('📝');
        expect(getResourceIcon('TEXT/HTML')).toBe('🌐');
      });
    });

    describe('Default Icon', () => {
      it('should return default icon for unknown media types', () => {
        expect(getResourceIcon('application/json')).toBe('📄');
        expect(getResourceIcon('application/pdf')).toBe('📄');
        expect(getResourceIcon('video/mp4')).toBe('📄');
        expect(getResourceIcon('audio/mpeg')).toBe('📄');
      });

      it('should return default icon for undefined', () => {
        expect(getResourceIcon(undefined)).toBe('📄');
      });

      it('should return default icon for empty string', () => {
        expect(getResourceIcon('')).toBe('📄');
      });

      it('should return default icon for whitespace-only string', () => {
        expect(getResourceIcon('   ')).toBe('📄');
      });
    });

    describe('Edge Cases', () => {
      it('should handle malformed media types', () => {
        expect(getResourceIcon('not-a-valid-media-type')).toBe('📄');
      });

      it('should handle media type with only semicolon', () => {
        expect(getResourceIcon(';')).toBe('📄');
      });

      it('should handle media type with multiple semicolons', () => {
        expect(getResourceIcon('text/plain; charset=utf-8; boundary=something')).toBe('📄');
      });

      it('should trim whitespace in base type', () => {
        expect(getResourceIcon('  text/markdown  ; charset=utf-8')).toBe('📝');
      });
    });
  });

  describe('supportsDetection', () => {
    describe('Supported Types', () => {
      it('should return true for text/plain', () => {
        expect(supportsDetection('text/plain')).toBe(true);
      });

      it('should return true for text/markdown', () => {
        expect(supportsDetection('text/markdown')).toBe(true);
      });

      it('should return true for text/html', () => {
        expect(supportsDetection('text/html')).toBe(true);
      });

      it('should return true for application/json (text-selector anchoring)', () => {
        expect(supportsDetection('application/json')).toBe(true);
      });

      it('should return true for text/* with charset', () => {
        expect(supportsDetection('text/plain; charset=utf-8')).toBe(true);
        expect(supportsDetection('text/markdown; charset=iso-8859-1')).toBe(true);
      });

      it('should handle uppercase TEXT/*', () => {
        expect(supportsDetection('TEXT/PLAIN')).toBe(true);
        expect(supportsDetection('TEXT/MARKDOWN')).toBe(true);
      });

      it('should handle mixed case TEXT/*', () => {
        expect(supportsDetection('Text/Plain')).toBe(true);
      });
    });

    describe('Unsupported Types', () => {
      it('should return false for image types', () => {
        const imageTypes = [
          'image/jpeg',
          'image/png',
          'image/gif',
        ];

        imageTypes.forEach(type => {
          expect(supportsDetection(type)).toBe(false);
        });
      });

      it('should return false for application types (except json)', () => {
        const appTypes = [
          'application/pdf',
          'application/zip',
          'application/octet-stream',
        ];

        appTypes.forEach(type => {
          expect(supportsDetection(type)).toBe(false);
        });
      });

      it('should return false for storage-tier text/* types (no text-selector anchoring)', () => {
        // Detection produces text-position annotations, so it is offered only
        // for the text-selector types — not for catalogued storage-tier text
        // (csv, xml, source code) which the registry anchors as 'none'.
        const storageTierText = [
          'text/csv',
          'text/xml',
          'text/javascript',
          'text/css',
          'text/calendar',
        ];

        storageTierText.forEach(type => {
          expect(supportsDetection(type)).toBe(false);
        });
      });

      it('should return false for video types', () => {
        expect(supportsDetection('video/mp4')).toBe(false);
      });

      it('should return false for audio types', () => {
        expect(supportsDetection('audio/mpeg')).toBe(false);
      });

      it('should return false for undefined', () => {
        expect(supportsDetection(undefined)).toBe(false);
      });

      it('should return false for empty string', () => {
        expect(supportsDetection('')).toBe(false);
      });

      it('should return false for whitespace-only string', () => {
        expect(supportsDetection('   ')).toBe(false);
      });
    });

    describe('Edge Cases', () => {
      it('should return false for malformed media types', () => {
        expect(supportsDetection('not-a-valid-media-type')).toBe(false);
      });

      it('should return false for media type with only semicolon', () => {
        expect(supportsDetection(';')).toBe(false);
      });

      it('should handle media type with multiple parameters', () => {
        expect(supportsDetection('text/plain; charset=utf-8; format=flowed')).toBe(true);
      });

      it('should trim whitespace in base type', () => {
        expect(supportsDetection('  text/plain  ; charset=utf-8')).toBe(true);
      });

      it('should return false for text-like but not text/* types', () => {
        expect(supportsDetection('application/xml')).toBe(false);
        expect(supportsDetection('application/javascript')).toBe(false);
      });
    });
  });
});
