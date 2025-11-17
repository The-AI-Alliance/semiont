/**
 * SVG Selector Validation Tests for Create Annotation Route
 *
 * Tests that the POST /resources/:id/annotations route correctly validates
 * SvgSelector markup according to W3C standards.
 */

import { describe, test, expect } from 'vitest';
import { validateSvgMarkup, getSvgSelector } from '@semiont/api-client';
import type { components } from '@semiont/api-client';

type SvgSelector = components['schemas']['SvgSelector'];
type TextPositionSelector = components['schemas']['TextPositionSelector'];

describe('SVG Selector Validation', () => {
  describe('validateSvgMarkup', () => {
    test('should accept valid SVG with xmlns and rect', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="50"/></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeNull();
    });

    test('should accept valid SVG with circle', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeNull();
    });

    test('should accept valid SVG with polygon', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="200,10 250,190 160,210"/></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeNull();
    });

    test('should accept valid SVG with path', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M150 0 L75 200 L225 200 Z"/></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeNull();
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

    test('should reject SVG without shape elements', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeTruthy();
      expect(error).toContain('shape element');
    });
  });

  describe('getSvgSelector', () => {
    test('should extract SvgSelector from single selector', () => {
      const selector: SvgSelector = {
        type: 'SvgSelector',
        value: '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="50"/></svg>'
      };

      const result = getSvgSelector(selector);
      expect(result).toEqual(selector);
    });

    test('should extract SvgSelector from mixed selector array', () => {
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

    test('should return null when no SvgSelector present', () => {
      const posSelector: TextPositionSelector = {
        type: 'TextPositionSelector',
        start: 0,
        end: 10
      };

      expect(getSvgSelector(posSelector)).toBeNull();
      expect(getSvgSelector([posSelector])).toBeNull();
      expect(getSvgSelector(undefined)).toBeNull();
    });
  });

  describe('Selector acceptance criteria', () => {
    test('should accept annotation with valid SvgSelector', () => {
      const selector: SvgSelector = {
        type: 'SvgSelector',
        value: '<svg xmlns="http://www.w3.org/2000/svg"><rect x="100" y="150" width="200" height="100"/></svg>'
      };

      const svgError = validateSvgMarkup(selector.value);
      expect(svgError).toBeNull();
    });

    test('should accept annotation with TextPositionSelector (existing behavior)', () => {
      const selector: TextPositionSelector = {
        type: 'TextPositionSelector',
        start: 10,
        end: 50
      };

      const result = getSvgSelector(selector);
      expect(result).toBeNull(); // Not an SVG selector, should pass through validation
    });

    test('should accept annotation with both selectors in array', () => {
      const posSelector: TextPositionSelector = {
        type: 'TextPositionSelector',
        start: 10,
        end: 50
      };

      const svgSelector: SvgSelector = {
        type: 'SvgSelector',
        value: '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 100,0 100,100 0,100"/></svg>'
      };

      const selectors = [posSelector, svgSelector];

      // Should be able to extract both
      expect(getSvgSelector(selectors)).toEqual(svgSelector);

      // SVG should be valid
      const svgError = validateSvgMarkup(svgSelector.value);
      expect(svgError).toBeNull();
    });
  });

  describe('Real-world SVG examples', () => {
    test('should accept SVG with viewBox and multiple shapes', () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
        <rect x="100" y="100" width="200" height="150" fill="blue" opacity="0.3"/>
        <circle cx="400" cy="300" r="50" stroke="red" fill="none"/>
      </svg>`;

      const error = validateSvgMarkup(svg);
      expect(error).toBeNull();
    });

    test('should accept SVG with complex path for freehand annotation', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M10,10 L50,50 L90,30 Q100,50 110,30 T130,30" stroke="black" fill="none"/></svg>';
      const error = validateSvgMarkup(svg);
      expect(error).toBeNull();
    });

    test('should reject malformed SVG from user input', () => {
      const svg = '<svg><rect/></svg>'; // Missing xmlns
      const error = validateSvgMarkup(svg);
      expect(error).toBeTruthy();
      expect(error).toContain('xmlns');
    });

    test('should reject empty SVG', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'; // No shapes
      const error = validateSvgMarkup(svg);
      expect(error).toBeTruthy();
      expect(error).toContain('shape element');
    });
  });
});
