/**
 * FragmentSelector Utilities Tests
 *
 * Property-based tests for FragmentSelector extraction from W3C annotation selectors.
 */

import { describe, test, expect } from 'vitest';
import * as fc from 'fast-check';
import { getFragmentSelector } from '../utils/annotations';

// Arbitrary generators for different selector types
const fragmentSelectorArb = fc.record({
  type: fc.constant('FragmentSelector' as const),
  value: fc.string({ minLength: 5 }).map(s => `page=1&viewrect=${s}`),
  conformsTo: fc.option(fc.constant('http://tools.ietf.org/rfc/rfc3778'), { nil: undefined })
});

const textPositionSelectorArb = fc.record({
  type: fc.constant('TextPositionSelector' as const),
  start: fc.integer({ min: 0, max: 1000 }),
  end: fc.integer({ min: 0, max: 1000 })
});

const svgSelectorArb = fc.record({
  type: fc.constant('SvgSelector' as const),
  value: fc.constant('<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="100"/></svg>')
});

describe('FragmentSelector Utilities', () => {
  test('getFragmentSelector returns FragmentSelector when present in single selector', () => {
    fc.assert(
      fc.property(
        fragmentSelectorArb,
        (selector) => {
          const result = getFragmentSelector(selector);
          expect(result).toEqual(selector);
          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  test('getFragmentSelector returns FragmentSelector from mixed selector array', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fragmentSelectorArb, textPositionSelectorArb, svgSelectorArb), { minLength: 1, maxLength: 5 }),
        (selectors) => {
          const result = getFragmentSelector(selectors);

          const expectedFragment = selectors.find(s => s.type === 'FragmentSelector');

          if (expectedFragment && expectedFragment.type === 'FragmentSelector') {
            expect(result).toEqual(expectedFragment);
          } else {
            expect(result).toBeNull();
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('getFragmentSelector returns first FragmentSelector when multiple exist', () => {
    fc.assert(
      fc.property(
        fc.array(fragmentSelectorArb, { minLength: 2, maxLength: 5 }),
        (fragmentSelectors) => {
          const result = getFragmentSelector(fragmentSelectors);
          expect(result).toEqual(fragmentSelectors[0]);
          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  test('getFragmentSelector returns null when no FragmentSelector present', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(textPositionSelectorArb, svgSelectorArb), { minLength: 1, maxLength: 5 }),
        (selectors) => {
          const result = getFragmentSelector(selectors);
          expect(result).toBeNull();
          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  test('getFragmentSelector returns null for undefined', () => {
    const result = getFragmentSelector(undefined);
    expect(result).toBeNull();
  });

  test('getFragmentSelector handles FragmentSelector with and without conformsTo', () => {
    fc.assert(
      fc.property(
        fragmentSelectorArb,
        (selector) => {
          const result = getFragmentSelector(selector);

          expect(result?.type).toBe('FragmentSelector');
          expect(result?.value).toBe(selector.value);

          if (selector.conformsTo) {
            expect(result?.conformsTo).toBe(selector.conformsTo);
          } else {
            expect(result?.conformsTo).toBeUndefined();
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
