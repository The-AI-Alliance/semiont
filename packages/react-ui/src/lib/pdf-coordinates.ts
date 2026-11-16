/**
 * PDF Canvas Coordinate Transforms
 *
 * Converts between canvas space (pixels, top-left origin, Y increases downward)
 * and PDF space (points, bottom-left origin, Y increases upward) — the Y-flip and
 * scale. UI-only: the server has no canvas.
 *
 * `PdfCoordinate` and the viewrect FragmentSelector codec live in `@semiont/core`.
 *
 * Based on RFC 3778 PDF Fragment Identifiers:
 * https://tools.ietf.org/html/rfc3778
 */

import type { PdfCoordinate } from '@semiont/core';

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasRectangle {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * Convert canvas coordinates to PDF coordinates
 *
 * Canvas: Origin at top-left, Y increases downward
 * PDF: Origin at bottom-left, Y increases upward
 *
 * @param canvasRect - Rectangle in canvas pixel coordinates
 * @param page - PDF page number (1-indexed)
 * @param pageWidth - PDF page width in points
 * @param pageHeight - PDF page height in points
 * @param scale - Current canvas scale factor
 */
export function canvasToPdfCoordinates(
  canvasRect: CanvasRectangle,
  page: number,
  _pageWidth: number,
  pageHeight: number,
  scale: number = 1
): PdfCoordinate {
  // Normalize rectangle (handle drag in any direction)
  const x1 = Math.min(canvasRect.startX, canvasRect.endX);
  const y1 = Math.min(canvasRect.startY, canvasRect.endY);
  const x2 = Math.max(canvasRect.startX, canvasRect.endX);
  const y2 = Math.max(canvasRect.startY, canvasRect.endY);

  // Convert from canvas pixels to PDF points
  const pdfX = x1 / scale;
  const pdfWidth = (x2 - x1) / scale;

  // Flip Y coordinate (canvas top-left to PDF bottom-left)
  const pdfY = pageHeight - (y2 / scale);
  const pdfHeight = (y2 - y1) / scale;

  return {
    page,
    x: Math.round(pdfX),
    y: Math.round(pdfY),
    width: Math.round(pdfWidth),
    height: Math.round(pdfHeight)
  };
}

/**
 * Convert PDF coordinates to canvas coordinates
 *
 * @param pdfCoord - Coordinates in PDF space
 * @param pageHeight - PDF page height in points
 * @param scale - Current canvas scale factor
 */
export function pdfToCanvasCoordinates(
  pdfCoord: PdfCoordinate,
  pageHeight: number,
  scale: number = 1
): Rectangle {
  // Convert from PDF points to canvas pixels
  const canvasX = pdfCoord.x * scale;
  const canvasWidth = pdfCoord.width * scale;

  // Flip Y coordinate (PDF bottom-left to canvas top-left)
  const canvasY = (pageHeight - pdfCoord.y - pdfCoord.height) * scale;
  const canvasHeight = pdfCoord.height * scale;

  return {
    x: canvasX,
    y: canvasY,
    width: canvasWidth,
    height: canvasHeight
  };
}
