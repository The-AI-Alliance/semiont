/**
 * MIME Extensions Tests
 * Tests for MIME type to file extension mapping utilities
 */

import { describe, it, expect } from 'vitest';
import { getExtensionForMimeType, hasKnownExtension } from '../mime-extensions';

describe('mime-extensions', () => {
  describe('getExtensionForMimeType', () => {
    describe('Text formats', () => {
      it('should return .txt for text/plain', () => {
        expect(getExtensionForMimeType('text/plain')).toBe('.txt');
      });

      it('should return .md for text/markdown', () => {
        expect(getExtensionForMimeType('text/markdown')).toBe('.md');
      });

      it('should return .html for text/html', () => {
        expect(getExtensionForMimeType('text/html')).toBe('.html');
      });

      it('should return .css for text/css', () => {
        expect(getExtensionForMimeType('text/css')).toBe('.css');
      });

      it('should return .csv for text/csv', () => {
        expect(getExtensionForMimeType('text/csv')).toBe('.csv');
      });

      it('should return .xml for text/xml', () => {
        expect(getExtensionForMimeType('text/xml')).toBe('.xml');
      });
    });

    describe('Image formats', () => {
      it('should return .png for image/png', () => {
        expect(getExtensionForMimeType('image/png')).toBe('.png');
      });

      it('should return .jpg for image/jpeg', () => {
        expect(getExtensionForMimeType('image/jpeg')).toBe('.jpg');
      });

      it('should return .gif for image/gif', () => {
        expect(getExtensionForMimeType('image/gif')).toBe('.gif');
      });

      it('should return .webp for image/webp', () => {
        expect(getExtensionForMimeType('image/webp')).toBe('.webp');
      });

      it('should return .svg for image/svg+xml', () => {
        expect(getExtensionForMimeType('image/svg+xml')).toBe('.svg');
      });

      it('should return .bmp for image/bmp', () => {
        expect(getExtensionForMimeType('image/bmp')).toBe('.bmp');
      });

      it('should return .tiff for image/tiff', () => {
        expect(getExtensionForMimeType('image/tiff')).toBe('.tiff');
      });

      it('should return .ico for image/x-icon', () => {
        expect(getExtensionForMimeType('image/x-icon')).toBe('.ico');
      });
    });

    describe('Video formats', () => {
      it('should return .mp4 for video/mp4', () => {
        expect(getExtensionForMimeType('video/mp4')).toBe('.mp4');
      });

      it('should return .mpeg for video/mpeg', () => {
        expect(getExtensionForMimeType('video/mpeg')).toBe('.mpeg');
      });

      it('should return .webm for video/webm', () => {
        expect(getExtensionForMimeType('video/webm')).toBe('.webm');
      });

      it('should return .ogv for video/ogg', () => {
        expect(getExtensionForMimeType('video/ogg')).toBe('.ogv');
      });

      it('should return .mov for video/quicktime', () => {
        expect(getExtensionForMimeType('video/quicktime')).toBe('.mov');
      });

      it('should return .avi for video/x-msvideo', () => {
        expect(getExtensionForMimeType('video/x-msvideo')).toBe('.avi');
      });
    });

    describe('Audio formats', () => {
      it('should return .mp3 for audio/mpeg', () => {
        expect(getExtensionForMimeType('audio/mpeg')).toBe('.mp3');
      });

      it('should return .wav for audio/wav', () => {
        expect(getExtensionForMimeType('audio/wav')).toBe('.wav');
      });

      it('should return .ogg for audio/ogg', () => {
        expect(getExtensionForMimeType('audio/ogg')).toBe('.ogg');
      });

      it('should return .webm for audio/webm', () => {
        expect(getExtensionForMimeType('audio/webm')).toBe('.webm');
      });

      it('should return .aac for audio/aac', () => {
        expect(getExtensionForMimeType('audio/aac')).toBe('.aac');
      });

      it('should return .flac for audio/flac', () => {
        expect(getExtensionForMimeType('audio/flac')).toBe('.flac');
      });
    });

    describe('Application formats - structured data', () => {
      it('should return .json for application/json', () => {
        expect(getExtensionForMimeType('application/json')).toBe('.json');
      });

      it('should return .xml for application/xml', () => {
        expect(getExtensionForMimeType('application/xml')).toBe('.xml');
      });

      it('should return .yaml for application/yaml', () => {
        expect(getExtensionForMimeType('application/yaml')).toBe('.yaml');
      });

      it('should return .yaml for application/x-yaml', () => {
        expect(getExtensionForMimeType('application/x-yaml')).toBe('.yaml');
      });
    });

    describe('Application formats - documents', () => {
      it('should return .pdf for application/pdf', () => {
        expect(getExtensionForMimeType('application/pdf')).toBe('.pdf');
      });

      it('should return .doc for application/msword', () => {
        expect(getExtensionForMimeType('application/msword')).toBe('.doc');
      });

      it('should return .docx for Word document', () => {
        expect(getExtensionForMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('.docx');
      });

      it('should return .xls for application/vnd.ms-excel', () => {
        expect(getExtensionForMimeType('application/vnd.ms-excel')).toBe('.xls');
      });

      it('should return .xlsx for Excel document', () => {
        expect(getExtensionForMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('.xlsx');
      });

      it('should return .ppt for application/vnd.ms-powerpoint', () => {
        expect(getExtensionForMimeType('application/vnd.ms-powerpoint')).toBe('.ppt');
      });

      it('should return .pptx for PowerPoint document', () => {
        expect(getExtensionForMimeType('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('.pptx');
      });
    });

    describe('Application formats - archives', () => {
      it('should return .zip for application/zip', () => {
        expect(getExtensionForMimeType('application/zip')).toBe('.zip');
      });

      it('should return .gz for application/gzip', () => {
        expect(getExtensionForMimeType('application/gzip')).toBe('.gz');
      });

      it('should return .tar for application/x-tar', () => {
        expect(getExtensionForMimeType('application/x-tar')).toBe('.tar');
      });

      it('should return .7z for application/x-7z-compressed', () => {
        expect(getExtensionForMimeType('application/x-7z-compressed')).toBe('.7z');
      });
    });

    describe('Application formats - executables/binaries', () => {
      it('should return .bin for application/octet-stream', () => {
        expect(getExtensionForMimeType('application/octet-stream')).toBe('.bin');
      });

      it('should return .wasm for application/wasm', () => {
        expect(getExtensionForMimeType('application/wasm')).toBe('.wasm');
      });
    });

    describe('Programming languages', () => {
      it('should return .js for text/javascript', () => {
        expect(getExtensionForMimeType('text/javascript')).toBe('.js');
      });

      it('should return .js for application/javascript', () => {
        expect(getExtensionForMimeType('application/javascript')).toBe('.js');
      });

      it('should return .ts for text/x-typescript', () => {
        expect(getExtensionForMimeType('text/x-typescript')).toBe('.ts');
      });

      it('should return .ts for application/typescript', () => {
        expect(getExtensionForMimeType('application/typescript')).toBe('.ts');
      });

      it('should return .py for text/x-python', () => {
        expect(getExtensionForMimeType('text/x-python')).toBe('.py');
      });

      it('should return .java for text/x-java', () => {
        expect(getExtensionForMimeType('text/x-java')).toBe('.java');
      });

      it('should return .c for text/x-c', () => {
        expect(getExtensionForMimeType('text/x-c')).toBe('.c');
      });

      it('should return .cpp for text/x-c++', () => {
        expect(getExtensionForMimeType('text/x-c++')).toBe('.cpp');
      });

      it('should return .cs for text/x-csharp', () => {
        expect(getExtensionForMimeType('text/x-csharp')).toBe('.cs');
      });

      it('should return .go for text/x-go', () => {
        expect(getExtensionForMimeType('text/x-go')).toBe('.go');
      });

      it('should return .rs for text/x-rust', () => {
        expect(getExtensionForMimeType('text/x-rust')).toBe('.rs');
      });

      it('should return .rb for text/x-ruby', () => {
        expect(getExtensionForMimeType('text/x-ruby')).toBe('.rb');
      });

      it('should return .php for text/x-php', () => {
        expect(getExtensionForMimeType('text/x-php')).toBe('.php');
      });

      it('should return .swift for text/x-swift', () => {
        expect(getExtensionForMimeType('text/x-swift')).toBe('.swift');
      });

      it('should return .kt for text/x-kotlin', () => {
        expect(getExtensionForMimeType('text/x-kotlin')).toBe('.kt');
      });

      it('should return .sh for text/x-shell', () => {
        expect(getExtensionForMimeType('text/x-shell')).toBe('.sh');
      });
    });

    describe('Font formats', () => {
      it('should return .woff for font/woff', () => {
        expect(getExtensionForMimeType('font/woff')).toBe('.woff');
      });

      it('should return .woff2 for font/woff2', () => {
        expect(getExtensionForMimeType('font/woff2')).toBe('.woff2');
      });

      it('should return .ttf for font/ttf', () => {
        expect(getExtensionForMimeType('font/ttf')).toBe('.ttf');
      });

      it('should return .otf for font/otf', () => {
        expect(getExtensionForMimeType('font/otf')).toBe('.otf');
      });
    });

    describe('Parameter handling', () => {
      it('should handle charset parameter', () => {
        expect(getExtensionForMimeType('text/plain; charset=utf-8')).toBe('.txt');
      });

      it('should handle multiple parameters', () => {
        expect(getExtensionForMimeType('text/html; charset=utf-8; boundary=something')).toBe('.html');
      });

      it('should handle whitespace around parameters', () => {
        expect(getExtensionForMimeType('text/plain ; charset=utf-8')).toBe('.txt');
      });

      it('should trim whitespace from MIME type', () => {
        expect(getExtensionForMimeType('  text/plain  ')).toBe('.txt');
      });
    });

    describe('Case sensitivity', () => {
      it('should be case-insensitive', () => {
        expect(getExtensionForMimeType('TEXT/PLAIN')).toBe('.txt');
        expect(getExtensionForMimeType('Image/PNG')).toBe('.png');
        expect(getExtensionForMimeType('Application/JSON')).toBe('.json');
      });

      it('should handle mixed case', () => {
        expect(getExtensionForMimeType('Text/Markdown')).toBe('.md');
      });
    });

    describe('Unknown MIME types', () => {
      it('should return .dat for unknown MIME type', () => {
        expect(getExtensionForMimeType('unknown/type')).toBe('.dat');
      });

      it('should return .dat for custom vendor type', () => {
        expect(getExtensionForMimeType('application/vnd.custom.format')).toBe('.dat');
      });

      it('should return .dat for empty string', () => {
        expect(getExtensionForMimeType('')).toBe('.dat');
      });
    });
  });

  describe('hasKnownExtension', () => {
    it('should return true for known text types', () => {
      expect(hasKnownExtension('text/plain')).toBe(true);
      expect(hasKnownExtension('text/markdown')).toBe(true);
      expect(hasKnownExtension('text/html')).toBe(true);
    });

    it('should return true for known image types', () => {
      expect(hasKnownExtension('image/png')).toBe(true);
      expect(hasKnownExtension('image/jpeg')).toBe(true);
      expect(hasKnownExtension('image/gif')).toBe(true);
    });

    it('should return true for known application types', () => {
      expect(hasKnownExtension('application/json')).toBe(true);
      expect(hasKnownExtension('application/pdf')).toBe(true);
    });

    it('should return true for known video types', () => {
      expect(hasKnownExtension('video/mp4')).toBe(true);
      expect(hasKnownExtension('video/webm')).toBe(true);
    });

    it('should return true for known audio types', () => {
      expect(hasKnownExtension('audio/mpeg')).toBe(true);
      expect(hasKnownExtension('audio/wav')).toBe(true);
    });

    it('should return true for known font types', () => {
      expect(hasKnownExtension('font/woff')).toBe(true);
      expect(hasKnownExtension('font/woff2')).toBe(true);
    });

    it('should return true for known programming language types', () => {
      expect(hasKnownExtension('text/javascript')).toBe(true);
      expect(hasKnownExtension('text/x-python')).toBe(true);
    });

    it('should return false for unknown MIME types', () => {
      expect(hasKnownExtension('unknown/type')).toBe(false);
    });

    it('should return false for custom vendor types', () => {
      expect(hasKnownExtension('application/vnd.custom.format')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(hasKnownExtension('')).toBe(false);
    });

    it('should handle MIME types with parameters', () => {
      expect(hasKnownExtension('text/plain; charset=utf-8')).toBe(true);
      expect(hasKnownExtension('application/json; charset=utf-8')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(hasKnownExtension('TEXT/PLAIN')).toBe(true);
      expect(hasKnownExtension('Image/PNG')).toBe(true);
    });

    it('should trim whitespace', () => {
      expect(hasKnownExtension('  text/plain  ')).toBe(true);
    });
  });
});
