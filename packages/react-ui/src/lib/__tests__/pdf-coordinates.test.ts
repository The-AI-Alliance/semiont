/**
 * PDF Canvas Coordinate Transform Tests
 *
 * Property-based tests for the canvas↔PDF coordinate transforms (Y-flip + scale).
 * The viewrect FragmentSelector codec moved to @semiont/core; its tests live in
 * packages/core/src/__tests__/pdf-coordinates.test.ts.
 *
 * AXIOMS FOR PDF COORDINATE TRANSFORMATIONS:
 *
 * 1. ROUND-TRIP PRESERVATION: Converting canvas → PDF → canvas must preserve
 *    the original coordinates (within rounding error)
 *
 * 2. NORMALIZATION: Rectangles must always have positive width/height regardless
 *    of drag direction (top-left to bottom-right vs bottom-right to top-left)
 *
 * 3. SCALE PROPORTIONALITY: Coordinate dimensions should scale inversely with
 *    the scale factor (2x scale = half the PDF point dimensions)
 *
 * 4. Y-AXIS FLIP CONSISTENCY: Canvas (top-left origin) to PDF (bottom-left origin)
 *    transformations must be consistent and reversible
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  canvasToPdfCoordinates,
  pdfToCanvasCoordinates,
  type CanvasRectangle
} from '../pdf-coordinates';
import type { PdfCoordinate } from '@semiont/core';

describe('PDF Coordinate Transformations', () => {
  // AXIOM 1: Round-Trip Preservation
  it('canvas → PDF → canvas preserves coordinates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 400, max: 1200 }),
        fc.integer({ min: 400, max: 1200 }),
        fc.double({ min: 0.5, max: 3.0, noNaN: true }),
        (startX, startY, endX, endY, pageWidth, pageHeight, scale) => {
          const rect: CanvasRectangle = { startX, startY, endX, endY };

          // Canvas -> PDF
          const pdf = canvasToPdfCoordinates(rect, 1, pageWidth, pageHeight, scale);

          // PDF -> Canvas
          const canvas = pdfToCanvasCoordinates(pdf, pageHeight, scale);

          const originalX = Math.min(startX, endX);
          const originalY = Math.min(startY, endY);
          const originalWidth = Math.abs(endX - startX);
          const originalHeight = Math.abs(endY - startY);

          // Allow 3px rounding error for scaled coordinates (due to floating point math)
          expect(Math.abs(canvas.x - originalX)).toBeLessThanOrEqual(3);
          expect(Math.abs(canvas.y - originalY)).toBeLessThanOrEqual(3);
          expect(Math.abs(canvas.width - originalWidth)).toBeLessThanOrEqual(3);
          expect(Math.abs(canvas.height - originalHeight)).toBeLessThanOrEqual(3);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // AXIOM 2: Normalization
  it('width and height are always positive after normalization', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 400, max: 1200 }),
        fc.integer({ min: 400, max: 1200 }),
        fc.double({ min: 0.5, max: 3.0, noNaN: true }),
        (startX, startY, endX, endY, pageWidth, pageHeight, scale) => {
          const rect: CanvasRectangle = { startX, startY, endX, endY };
          const pdf = canvasToPdfCoordinates(rect, 1, pageWidth, pageHeight, scale);

          expect(pdf.width).toBeGreaterThanOrEqual(0);
          expect(pdf.height).toBeGreaterThanOrEqual(0);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // AXIOM 2 continued: Drag Direction Independence
  it('drag direction does not affect final coordinates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 400, max: 1200 }),
        fc.integer({ min: 400, max: 1200 }),
        fc.double({ min: 0.5, max: 3.0, noNaN: true }),
        (x1, y1, x2, y2, pageWidth, pageHeight, scale) => {
          // Test all 4 drag directions
          const rects: CanvasRectangle[] = [
            { startX: x1, startY: y1, endX: x2, endY: y2 },
            { startX: x2, startY: y1, endX: x1, endY: y2 },
            { startX: x2, startY: y2, endX: x1, endY: y1 },
            { startX: x1, startY: y2, endX: x2, endY: y1 },
          ];

          const results = rects.map(rect =>
            canvasToPdfCoordinates(rect, 1, pageWidth, pageHeight, scale)
          );

          // All should produce identical result
          results.forEach(result => {
            expect(result).toEqual(results[0]);
          });

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  // AXIOM 3: Scale Proportionality
  it('doubling scale halves PDF dimensions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 800 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 400, max: 1200 }),
        fc.integer({ min: 400, max: 1200 }),
        fc.double({ min: 0.5, max: 1.5, noNaN: true }),
        (startX, startY, endX, endY, pageWidth, pageHeight, scale) => {
          const rect: CanvasRectangle = { startX, startY, endX, endY };

          const result1 = canvasToPdfCoordinates(rect, 1, pageWidth, pageHeight, scale);
          const result2 = canvasToPdfCoordinates(rect, 1, pageWidth, pageHeight, scale * 2);

          // Width and height should be halved (with 2px rounding tolerance)
          expect(Math.abs(result2.width - result1.width / 2)).toBeLessThanOrEqual(2);
          expect(Math.abs(result2.height - result1.height / 2)).toBeLessThanOrEqual(2);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  // AXIOM 4: Y-Axis Flip Consistency
  it('Y-axis flip is consistent between PDF and canvas coordinate systems', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 100, max: 200 }),
        fc.integer({ min: 100, max: 200 }),
        fc.integer({ min: 400, max: 1200 }),
        (x, y, width, height, pageHeight) => {
          const pdfCoord: PdfCoordinate = { page: 1, x, y, width, height };
          const canvas = pdfToCanvasCoordinates(pdfCoord, pageHeight, 1.0);

          // Y coordinate should be flipped: PDF bottom-left (y=0) maps to canvas top (y=pageHeight)
          const expectedCanvasY = pageHeight - y - height;
          expect(canvas.y).toBe(expectedCanvasY);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
