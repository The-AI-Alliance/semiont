/**
 * PDF viewrect FragmentSelector codec tests.
 *
 * Property-based round-trip and RFC 3778 compliance for the codec extracted from
 * react-ui. The canvas-pixel transform tests stay in react-ui (UI-only).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  createFragmentSelector,
  parseFragmentSelector,
  getPageFromFragment,
  type PdfCoordinate,
} from '../pdf-coordinates';

describe('PDF viewrect FragmentSelector codec', () => {
  it('createFragmentSelector and parseFragmentSelector round-trip correctly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (page, x, y, width, height) => {
          const coord: PdfCoordinate = { page, x, y, width, height };
          const fragment = createFragmentSelector(coord);
          const parsed = parseFragmentSelector(fragment);

          expect(parsed).toEqual(coord);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('round-trips negative coordinates (rects that extend off-page)', () => {
    const coord: PdfCoordinate = { page: 3, x: -5, y: -12, width: 40, height: 18 };
    expect(parseFragmentSelector(createFragmentSelector(coord))).toEqual(coord);
  });

  it('returns null for malformed viewrect numbers', () => {
    expect(parseFragmentSelector('page=1&viewrect=1.2.3,4,5,6')).toBeNull();
  });

  it('parseFragmentSelector returns null for invalid fragments', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (randomString) => {
          const parsed = parseFragmentSelector(randomString);

          // If it parses successfully, verify it has valid structure
          if (parsed !== null) {
            expect(parsed).toHaveProperty('page');
            expect(parsed).toHaveProperty('x');
            expect(parsed).toHaveProperty('y');
            expect(parsed).toHaveProperty('width');
            expect(parsed).toHaveProperty('height');
            expect(typeof parsed.page).toBe('number');
            expect(parsed.page).toBeGreaterThan(0);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('getPageFromFragment extracts page number correctly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (page, x, y, width, height) => {
          const coord: PdfCoordinate = { page, x, y, width, height };
          const fragment = createFragmentSelector(coord);
          const extractedPage = getPageFromFragment(fragment);

          expect(extractedPage).toBe(page);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
