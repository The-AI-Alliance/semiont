/**
 * Media-Type Registry Test Suite
 *
 * Pins the capability registry's rows and the behavior of its helpers.
 * The extension expectations absorb the test data that previously lived
 * in packages/content's mime-extensions tests.
 */

import { describe, it, expect } from 'vitest';
import {
  MEDIA_TYPES,
  baseMediaType,
  isSupportedMediaType,
  capabilitiesOf,
  extensionForMediaType,
  mediaTypeForExtension,
  textExtractionOf,
  AUTHORABLE_MEDIA_TYPES,
  EMBEDDABLE_MEDIA_TYPES,
  type SupportedMediaType,
} from '../media-types';

describe('media-types registry', () => {
  describe('registry invariants', () => {
    const rows = Object.entries(MEDIA_TYPES);

    it('has a dotted extension and a label on every row', () => {
      for (const [type, caps] of rows) {
        expect(caps.extension.startsWith('.'), `${type} extension`).toBe(true);
        expect(caps.extension.length, `${type} extension`).toBeGreaterThan(1);
        expect(caps.label.length, `${type} label`).toBeGreaterThan(0);
      }
    });

    it('is a big tent: every admitted type is uploadable', () => {
      for (const [type, caps] of rows) {
        expect(caps.uploadable, type).toBe(true);
      }
    });

    it('only offers text-rendered types in the compose editor', () => {
      for (const [type, caps] of rows) {
        if (caps.authorable) {
          expect(caps.render, type).toBe('text');
        }
      }
    });

    it('extracts text from every text/* row (embed anything that decodes as text)', () => {
      for (const [type, caps] of rows) {
        if (type.startsWith('text/')) {
          expect(caps.extractText, type).toBe('decode');
        }
      }
    });
  });

  describe('full-capability tier', () => {
    it('pins the seven curated rows', () => {
      expect(MEDIA_TYPES['text/markdown']).toEqual({
        extension: '.md', label: 'Markdown', render: 'text', anchoring: 'text-selector',
        extractText: 'decode', authorable: true, uploadable: true,
      });
      expect(MEDIA_TYPES['text/plain']).toEqual({
        extension: '.txt', label: 'Plain Text', render: 'text', anchoring: 'text-selector',
        extractText: 'decode', authorable: true, uploadable: true,
      });
      expect(MEDIA_TYPES['text/html']).toEqual({
        extension: '.html', label: 'HTML', render: 'text', anchoring: 'text-selector',
        extractText: 'decode', authorable: true, uploadable: true,
      });
      expect(MEDIA_TYPES['application/json']).toEqual({
        extension: '.json', label: 'JSON', render: 'text', anchoring: 'text-selector',
        extractText: 'decode', authorable: false, uploadable: true,
      });
      expect(MEDIA_TYPES['image/png']).toEqual({
        extension: '.png', label: 'PNG image', render: 'image', anchoring: 'spatial',
        extractText: 'none', authorable: false, uploadable: true,
      });
      expect(MEDIA_TYPES['image/jpeg']).toEqual({
        extension: '.jpg', label: 'JPEG image', render: 'image', anchoring: 'spatial',
        extractText: 'none', authorable: false, uploadable: true,
      });
      expect(MEDIA_TYPES['application/pdf']).toEqual({
        extension: '.pdf', label: 'PDF', render: 'pdf', anchoring: 'spatial',
        extractText: 'pdf-text-layer', authorable: false, uploadable: true,
      });
    });
  });

  describe('anchoring models', () => {
    it('groups spatial annotation types together (PDFs annotate like images)', () => {
      expect(MEDIA_TYPES['application/pdf'].anchoring).toBe('spatial');
      expect(MEDIA_TYPES['image/png'].anchoring).toBe('spatial');
      expect(MEDIA_TYPES['image/jpeg'].anchoring).toBe('spatial');
    });

    it('groups text annotation types together', () => {
      expect(MEDIA_TYPES['text/plain'].anchoring).toBe('text-selector');
      expect(MEDIA_TYPES['text/markdown'].anchoring).toBe('text-selector');
    });

    it('leaves storage-tier types unannotatable', () => {
      expect(MEDIA_TYPES['application/zip'].anchoring).toBe('none');
      expect(MEDIA_TYPES['image/gif'].anchoring).toBe('none');
      expect(MEDIA_TYPES['text/csv'].anchoring).toBe('none');
    });
  });

  describe('extension mapping (data formerly pinned in @semiont/content)', () => {
    const expectations: Record<SupportedMediaType, string> = {
      'text/plain': '.txt',
      'text/markdown': '.md',
      'text/html': '.html',
      'text/css': '.css',
      'text/csv': '.csv',
      'text/xml': '.xml',
      'application/json': '.json',
      'application/xml': '.xml',
      'application/yaml': '.yaml',
      'application/x-yaml': '.yaml',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'application/zip': '.zip',
      'application/gzip': '.gz',
      'application/x-tar': '.tar',
      'application/x-7z-compressed': '.7z',
      'application/octet-stream': '.bin',
      'application/wasm': '.wasm',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'image/bmp': '.bmp',
      'image/tiff': '.tiff',
      'image/x-icon': '.ico',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/webm': '.webm',
      'audio/aac': '.aac',
      'audio/flac': '.flac',
      'video/mp4': '.mp4',
      'video/mpeg': '.mpeg',
      'video/webm': '.webm',
      'video/ogg': '.ogv',
      'video/quicktime': '.mov',
      'video/x-msvideo': '.avi',
      'text/javascript': '.js',
      'application/javascript': '.js',
      'text/x-typescript': '.ts',
      'application/typescript': '.ts',
      'text/x-python': '.py',
      'text/x-java': '.java',
      'text/x-c': '.c',
      'text/x-c++': '.cpp',
      'text/x-csharp': '.cs',
      'text/x-go': '.go',
      'text/x-rust': '.rs',
      'text/x-ruby': '.rb',
      'text/x-php': '.php',
      'text/x-swift': '.swift',
      'text/x-kotlin': '.kt',
      'text/x-shell': '.sh',
      'font/woff': '.woff',
      'font/woff2': '.woff2',
      'font/ttf': '.ttf',
      'font/otf': '.otf',
    };

    it('maps every registry type to its canonical extension', () => {
      for (const [type, extension] of Object.entries(expectations)) {
        expect(extensionForMediaType(type), type).toBe(extension);
      }
    });

    it('covers the registry exactly (no unpinned rows)', () => {
      expect(Object.keys(expectations).sort()).toEqual(Object.keys(MEDIA_TYPES).sort());
    });
  });

  describe('baseMediaType', () => {
    it('strips charset parameters', () => {
      expect(baseMediaType('text/plain; charset=utf-8')).toBe('text/plain');
      expect(baseMediaType('text/markdown; charset=windows-1252')).toBe('text/markdown');
    });

    it('strips multiple parameters', () => {
      expect(baseMediaType('multipart/form-data; boundary=x; charset=utf-8')).toBe('multipart/form-data');
    });

    it('lowercases and trims', () => {
      expect(baseMediaType('TEXT/PLAIN')).toBe('text/plain');
      expect(baseMediaType('  image/PNG ; charset=binary')).toBe('image/png');
    });

    it('passes bare base types through', () => {
      expect(baseMediaType('application/pdf')).toBe('application/pdf');
    });
  });

  describe('isSupportedMediaType', () => {
    it('admits registry members', () => {
      expect(isSupportedMediaType('text/markdown')).toBe(true);
      expect(isSupportedMediaType('application/octet-stream')).toBe(true);
      expect(isSupportedMediaType('font/woff2')).toBe(true);
    });

    it('rejects strings carrying parameters (callers strip via baseMediaType)', () => {
      expect(isSupportedMediaType('text/plain; charset=utf-8')).toBe(false);
    });

    it('rejects unknown and malformed types', () => {
      expect(isSupportedMediaType('text/markdwon')).toBe(false);
      expect(isSupportedMediaType('not-a-mime-type')).toBe(false);
      expect(isSupportedMediaType('')).toBe(false);
    });

    it('rejects non-normalized case', () => {
      expect(isSupportedMediaType('TEXT/PLAIN')).toBe(false);
    });

    it('is not fooled by Object prototype properties', () => {
      expect(isSupportedMediaType('toString')).toBe(false);
      expect(isSupportedMediaType('constructor')).toBe(false);
    });
  });

  describe('capabilitiesOf', () => {
    it('looks up registry rows', () => {
      expect(capabilitiesOf('application/pdf')?.render).toBe('pdf');
    });

    it('tolerates parameters and case', () => {
      expect(capabilitiesOf('text/plain; charset=utf-8')?.extension).toBe('.txt');
      expect(capabilitiesOf('IMAGE/PNG')?.render).toBe('image');
    });

    it('returns undefined on registry miss — the mandatory branch', () => {
      expect(capabilitiesOf('application/x-proprietary')).toBeUndefined();
      expect(capabilitiesOf('')).toBeUndefined();
    });
  });

  describe('extensionForMediaType (lenient, for naming foreign content)', () => {
    it('returns the canonical extension for registry types', () => {
      expect(extensionForMediaType('text/markdown')).toBe('.md');
      expect(extensionForMediaType('text/markdown; charset=utf-8')).toBe('.md');
    });

    it('falls back to .dat on registry miss instead of refusing', () => {
      expect(extensionForMediaType('application/x-proprietary')).toBe('.dat');
      expect(extensionForMediaType('')).toBe('.dat');
    });
  });

  describe('mediaTypeForExtension (detection chain)', () => {
    it('inverts the registry', () => {
      expect(mediaTypeForExtension('.md')).toBe('text/markdown');
      expect(mediaTypeForExtension('.txt')).toBe('text/plain');
      expect(mediaTypeForExtension('.pdf')).toBe('application/pdf');
      expect(mediaTypeForExtension('.png')).toBe('image/png');
    });

    it('accepts undotted and mixed-case extensions', () => {
      expect(mediaTypeForExtension('md')).toBe('text/markdown');
      expect(mediaTypeForExtension('.MD')).toBe('text/markdown');
    });

    it('accepts common alternate spellings', () => {
      expect(mediaTypeForExtension('.markdown')).toBe('text/markdown');
      expect(mediaTypeForExtension('.htm')).toBe('text/html');
      expect(mediaTypeForExtension('.jpeg')).toBe('image/jpeg');
      expect(mediaTypeForExtension('.yml')).toBe('application/yaml');
    });

    it('resolves extension collisions to the first registry row', () => {
      expect(mediaTypeForExtension('.xml')).toBe('text/xml');
      expect(mediaTypeForExtension('.yaml')).toBe('application/yaml');
      expect(mediaTypeForExtension('.js')).toBe('text/javascript');
      expect(mediaTypeForExtension('.ts')).toBe('text/x-typescript');
      expect(mediaTypeForExtension('.webm')).toBe('video/webm');
    });

    it('returns undefined for unknown extensions (chains fall back to octet-stream)', () => {
      expect(mediaTypeForExtension('.xyz')).toBeUndefined();
      expect(mediaTypeForExtension('')).toBeUndefined();
    });
  });

  describe('textExtractionOf (the Smelter gate)', () => {
    it('answers from registry rows', () => {
      expect(textExtractionOf('text/markdown')).toBe('decode');
      expect(textExtractionOf('application/json')).toBe('decode');
      expect(textExtractionOf('application/pdf')).toBe('pdf-text-layer');
      expect(textExtractionOf('image/png')).toBe('none');
      expect(textExtractionOf('application/zip')).toBe('none');
    });

    it('decodes unregistered text/* (RFC 2046 — imported text subtypes embed)', () => {
      expect(textExtractionOf('text/x-obscure-notation')).toBe('decode');
      expect(textExtractionOf('text/x-obscure-notation; charset=iso-8859-1')).toBe('decode');
    });

    it('never decodes unregistered non-text types — no mojibake', () => {
      expect(textExtractionOf('application/x-proprietary')).toBe('none');
      expect(textExtractionOf('chemical/x-pdb')).toBe('none');
    });

    it('treats SVG as binary despite its XML body (image/* is not text/*)', () => {
      expect(textExtractionOf('image/svg+xml')).toBe('none');
    });
  });

  describe('derived lists', () => {
    it('AUTHORABLE_MEDIA_TYPES is exactly the compose-editor set', () => {
      expect(AUTHORABLE_MEDIA_TYPES).toEqual(['text/markdown', 'text/plain', 'text/html']);
    });

    it('EMBEDDABLE_MEDIA_TYPES is exactly the rows with text extraction', () => {
      for (const type of EMBEDDABLE_MEDIA_TYPES) {
        expect(MEDIA_TYPES[type].extractText).not.toBe('none');
      }
      expect(EMBEDDABLE_MEDIA_TYPES).toContain('application/pdf');
      expect(EMBEDDABLE_MEDIA_TYPES).toContain('text/x-python');
      expect(EMBEDDABLE_MEDIA_TYPES).not.toContain('image/png');
      expect(EMBEDDABLE_MEDIA_TYPES).not.toContain('application/zip');
    });
  });
});
