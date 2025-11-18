/**
 * Unit tests for SVG Selector utilities
 */

import { describe, test, expect } from 'vitest';
import { getSvgSelector, validateSvgMarkup, extractBoundingBox } from '../utils/annotations';
import type { SvgSelector, TextPositionSelector } from '../utils/annotations';

describe('SVG Selector Utilities', () => {
  describe('getSvgSelector', () => {
    test('should return SvgSelector from single selector', () => {
      const selector: SvgSelector = {
        type: 'SvgSelector',
        value: '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="50"/></svg>'
      };

      const result = getSvgSelector(selector);
      expect(result).toEqual(selector);
    });

    test('should return SvgSelector from selector array', () => {
      const svgSelector: SvgSelector = {
        type: 'SvgSelector',
        value: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>'
      };

      const posSelector: TextPositionSelector = {
        type: 'TextPositionSelector',
        start: 0,
        end: 10
      };

      const result = getSvgSelector([posSelector, svgSelector]);
      expect(result).toEqual(svgSelector);
    });

    test('should return null if no SvgSelector found', () => {
      const posSelector: TextPositionSelector = {
        type: 'TextPositionSelector',
        start: 0,
        end: 10
      };

      expect(getSvgSelector(posSelector)).toBeNull();
      expect(getSvgSelector([posSelector])).toBeNull();
    });

    test('should return null for undefined selector', () => {
      expect(getSvgSelector(undefined)).toBeNull();
    });
  });

  describe('validateSvgMarkup', () => {
    test('should accept valid SVG with rect', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="50"/></svg>';
      expect(validateSvgMarkup(svg)).toBeNull();
    });

    test('should accept valid SVG with circle', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>';
      expect(validateSvgMarkup(svg)).toBeNull();
    });

    test('should accept valid SVG with polygon', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="200,10 250,190 160,210"/></svg>';
      expect(validateSvgMarkup(svg)).toBeNull();
    });

    test('should accept valid SVG with path', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M150 0 L75 200 L225 200 Z"/></svg>';
      expect(validateSvgMarkup(svg)).toBeNull();
    });

    test('should reject SVG without xmlns attribute', () => {
      const svg = '<svg><rect x="10" y="20" width="100" height="50"/></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeTruthy();
      expect(error).toContain('xmlns');
    });

    test('should reject SVG without closing tag', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="50"/>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeTruthy();
      expect(error).toContain('closing tag');
    });

    test('should reject SVG without opening tag', () => {
      const svg = '<rect x="10" y="20" width="100" height="50"/></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeTruthy();
      expect(error).toContain('xmlns');
    });

    test('should reject SVG without any shape elements', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeTruthy();
      expect(error).toContain('shape element');
    });
  });

  describe('extractBoundingBox', () => {
    test('should extract bounding box from viewBox attribute', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect x="10" y="20" width="100" height="50"/></svg>';
      const bbox = extractBoundingBox(svg);
      expect(bbox).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    });

    test('should extract bounding box from viewBox with non-zero origin', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 800 600"><rect x="10" y="20" width="100" height="50"/></svg>';
      const bbox = extractBoundingBox(svg);
      expect(bbox).toEqual({ x: 10, y: 20, width: 800, height: 600 });
    });

    test('should extract bounding box from width/height attributes', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect x="10" y="20" width="100" height="50"/></svg>';
      const bbox = extractBoundingBox(svg);
      expect(bbox).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    });

    test('should prefer viewBox over width/height', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800" width="800" height="600"><rect x="10" y="20" width="100" height="50"/></svg>';
      const bbox = extractBoundingBox(svg);
      expect(bbox).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    });

    test('should return null if no viewBox or width/height', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="50"/></svg>';
      const bbox = extractBoundingBox(svg);
      expect(bbox).toBeNull();
    });

    test('should return null for malformed viewBox', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="invalid"><rect x="10" y="20" width="100" height="50"/></svg>';
      const bbox = extractBoundingBox(svg);
      expect(bbox).toBeNull();
    });

    test('should return null for non-numeric width/height', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="auto"><rect x="10" y="20" width="100" height="50"/></svg>';
      const bbox = extractBoundingBox(svg);
      expect(bbox).toBeNull();
    });
  });
});
