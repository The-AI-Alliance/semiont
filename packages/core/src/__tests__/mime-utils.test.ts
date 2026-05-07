/**
 * MIME Utils Test Suite
 *
 * Tests for MIME type detection and categorization utilities,
 * including PDF support added in commit 3e8d4e7.
 */

import { describe, it, expect } from 'vitest';
import {
  getExtensionForMimeType,
  isImageMimeType,
  isTextMimeType,
  isPdfMimeType,
  getMimeCategory,
  type MimeCategory,
} from '../mime-utils';

describe('MIME Utils', () => {
  describe('getExtensionForMimeType', () => {
    it('should return txt for text/plain', () => {
      expect(getExtensionForMimeType('text/plain')).toBe('txt');
    });

    it('should return md for text/markdown', () => {
      expect(getExtensionForMimeType('text/markdown')).toBe('md');
    });

    it('should return png for image/png', () => {
      expect(getExtensionForMimeType('image/png')).toBe('png');
    });

    it('should return jpg for image/jpeg', () => {
      expect(getExtensionForMimeType('image/jpeg')).toBe('jpg');
    });

    it('should return pdf for application/pdf', () => {
      expect(getExtensionForMimeType('application/pdf')).toBe('pdf');
    });

    it('should return dat for unknown MIME types', () => {
      expect(getExtensionForMimeType('application/octet-stream')).toBe('dat');
      expect(getExtensionForMimeType('video/mp4')).toBe('dat');
      expect(getExtensionForMimeType('audio/mpeg')).toBe('dat');
    });
  });

  describe('isImageMimeType', () => {
    it('should return true for image/png', () => {
      expect(isImageMimeType('image/png')).toBe(true);
    });

    it('should return true for image/jpeg', () => {
      expect(isImageMimeType('image/jpeg')).toBe(true);
    });

    it('should return false for text MIME types', () => {
      expect(isImageMimeType('text/plain')).toBe(false);
      expect(isImageMimeType('text/markdown')).toBe(false);
    });

    it('should return false for application/pdf', () => {
      expect(isImageMimeType('application/pdf')).toBe(false);
    });

    it('should return false for other image types (not yet supported)', () => {
      expect(isImageMimeType('image/gif')).toBe(false);
      expect(isImageMimeType('image/svg+xml')).toBe(false);
      expect(isImageMimeType('image/webp')).toBe(false);
    });

    it('should return false for unknown MIME types', () => {
      expect(isImageMimeType('application/json')).toBe(false);
      expect(isImageMimeType('video/mp4')).toBe(false);
    });
  });

  describe('isTextMimeType', () => {
    it('should return true for text/plain', () => {
      expect(isTextMimeType('text/plain')).toBe(true);
    });

    it('should return true for text/markdown', () => {
      expect(isTextMimeType('text/markdown')).toBe(true);
    });

    it('should return false for image MIME types', () => {
      expect(isTextMimeType('image/png')).toBe(false);
      expect(isTextMimeType('image/jpeg')).toBe(false);
    });

    it('should return false for application/pdf', () => {
      expect(isTextMimeType('application/pdf')).toBe(false);
    });

    it('should return false for other text types (not yet supported)', () => {
      expect(isTextMimeType('text/html')).toBe(false);
      expect(isTextMimeType('text/csv')).toBe(false);
    });

    it('should return false for unknown MIME types', () => {
      expect(isTextMimeType('application/json')).toBe(false);
      expect(isTextMimeType('video/mp4')).toBe(false);
    });
  });

  describe('isPdfMimeType', () => {
    it('should return true for application/pdf', () => {
      expect(isPdfMimeType('application/pdf')).toBe(true);
    });

    it('should return false for text MIME types', () => {
      expect(isPdfMimeType('text/plain')).toBe(false);
      expect(isPdfMimeType('text/markdown')).toBe(false);
    });

    it('should return false for image MIME types', () => {
      expect(isPdfMimeType('image/png')).toBe(false);
      expect(isPdfMimeType('image/jpeg')).toBe(false);
    });

    it('should return false for unknown MIME types', () => {
      expect(isPdfMimeType('application/json')).toBe(false);
      expect(isPdfMimeType('application/octet-stream')).toBe(false);
    });
  });

  describe('getMimeCategory', () => {
    describe('text category', () => {
      it('should categorize text/plain as text', () => {
        expect(getMimeCategory('text/plain')).toBe('text');
      });

      it('should categorize text/markdown as text', () => {
        expect(getMimeCategory('text/markdown')).toBe('text');
      });
    });

    describe('image category', () => {
      it('should categorize image/png as image', () => {
        expect(getMimeCategory('image/png')).toBe('image');
      });

      it('should categorize image/jpeg as image', () => {
        expect(getMimeCategory('image/jpeg')).toBe('image');
      });

      it('should categorize application/pdf as image (spatial annotations)', () => {
        expect(getMimeCategory('application/pdf')).toBe('image');
      });
    });

    describe('unsupported category', () => {
      it('should categorize unknown MIME types as unsupported', () => {
        expect(getMimeCategory('application/json')).toBe('unsupported');
        expect(getMimeCategory('video/mp4')).toBe('unsupported');
        expect(getMimeCategory('audio/mpeg')).toBe('unsupported');
      });

      it('should categorize unsupported image formats as unsupported', () => {
        expect(getMimeCategory('image/gif')).toBe('unsupported');
        expect(getMimeCategory('image/svg+xml')).toBe('unsupported');
        expect(getMimeCategory('image/webp')).toBe('unsupported');
      });

      it('should categorize unsupported text formats as unsupported', () => {
        expect(getMimeCategory('text/html')).toBe('unsupported');
        expect(getMimeCategory('text/csv')).toBe('unsupported');
      });
    });

    describe('category semantics (annotation models)', () => {
      it('should group text-based annotation types together', () => {
        const textTypes: string[] = ['text/plain', 'text/markdown'];
        const categories = textTypes.map(getMimeCategory);
        expect(categories.every(c => c === 'text')).toBe(true);
      });

      it('should group spatial annotation types together', () => {
        const spatialTypes: string[] = ['image/png', 'image/jpeg', 'application/pdf'];
        const categories = spatialTypes.map(getMimeCategory);
        expect(categories.every(c => c === 'image')).toBe(true);
      });

      it('should distinguish annotation models not file formats', () => {
        // PDFs use spatial coordinates (like images), not text positions
        expect(getMimeCategory('application/pdf')).toBe('image');

        // Text files use text positions, not spatial coordinates
        expect(getMimeCategory('text/plain')).toBe('text');
      });
    });
  });

  describe('Type Safety', () => {
    it('should have correct MimeCategory type', () => {
      const validCategories: MimeCategory[] = ['text', 'image', 'unsupported'];
      validCategories.forEach(category => {
        expect(['text', 'image', 'unsupported']).toContain(category);
      });
    });

    it('should return valid MimeCategory from getMimeCategory', () => {
      const testTypes = [
        'text/plain',
        'text/markdown',
        'image/png',
        'image/jpeg',
        'application/pdf',
        'application/json',
        'unknown/type',
      ];

      testTypes.forEach(mimeType => {
        const category = getMimeCategory(mimeType);
        expect(['text', 'image', 'unsupported']).toContain(category);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      expect(getExtensionForMimeType('')).toBe('dat');
      expect(isImageMimeType('')).toBe(false);
      expect(isTextMimeType('')).toBe(false);
      expect(isPdfMimeType('')).toBe(false);
      expect(getMimeCategory('')).toBe('unsupported');
    });

    it('should handle case sensitivity', () => {
      // MIME types should be lowercase, but test behavior with uppercase
      expect(isImageMimeType('IMAGE/PNG')).toBe(false);
      expect(isTextMimeType('TEXT/PLAIN')).toBe(false);
      expect(isPdfMimeType('APPLICATION/PDF')).toBe(false);
    });

    it('should not match MIME types with charset parameters', () => {
      // Current implementation does exact match, not prefix match
      expect(isTextMimeType('text/plain; charset=utf-8')).toBe(false);
      expect(getMimeCategory('text/plain; charset=utf-8')).toBe('unsupported');
    });
  });

  describe('PDF Support (commit 3e8d4e7)', () => {
    it('should add PDF to extension mapping', () => {
      expect(getExtensionForMimeType('application/pdf')).toBe('pdf');
    });

    it('should provide isPdfMimeType helper', () => {
      expect(isPdfMimeType('application/pdf')).toBe(true);
      expect(isPdfMimeType('text/plain')).toBe(false);
    });

    it('should categorize PDFs as image (spatial annotations)', () => {
      expect(getMimeCategory('application/pdf')).toBe('image');
    });

    it('should group PDFs with images for annotation routing', () => {
      const pdfCategory = getMimeCategory('application/pdf');
      const pngCategory = getMimeCategory('image/png');
      const jpegCategory = getMimeCategory('image/jpeg');

      expect(pdfCategory).toBe(pngCategory);
      expect(pdfCategory).toBe(jpegCategory);
      expect(pdfCategory).toBe('image');
    });

    it('should distinguish PDFs from text types', () => {
      const pdfCategory = getMimeCategory('application/pdf');
      const plainCategory = getMimeCategory('text/plain');
      const mdCategory = getMimeCategory('text/markdown');

      expect(pdfCategory).not.toBe(plainCategory);
      expect(pdfCategory).not.toBe(mdCategory);
    });
  });
});
