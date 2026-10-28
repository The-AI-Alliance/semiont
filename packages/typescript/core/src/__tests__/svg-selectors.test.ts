/**
 * Unit tests for SVG Selector utilities
 */

import { describe, test, expect } from 'vitest';
import { getSvgSelector } from '../web-annotation-utils';
import type { SvgSelector, TextPositionSelector } from '../web-annotation-utils';

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
});
