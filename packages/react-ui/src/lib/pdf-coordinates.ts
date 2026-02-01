/**
 * PDF Coordinate Utilities
 *
 * Handles coordinate transformations between:
 * - Canvas space (pixels, top-left origin, Y increases downward)
 * - PDF space (points, bottom-left origin, Y increases upward)
 *
 * Based on RFC 3778 PDF Fragment Identifiers:
 * https://tools.ietf.org/html/rfc3778
 */

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfCoordinate {
  page: number;
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
  pageWidth: number,
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
  const canvasHeight = pageHeight * scale;
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

/**
 * Generate RFC 3778 FragmentSelector value
 *
 * Format: page=N&viewrect=left,top,width,height
 * All coordinates in PDF points
 */
export function createFragmentSelector(coord: PdfCoordinate): string {
  return `page=${coord.page}&viewrect=${coord.x},${coord.y},${coord.width},${coord.height}`;
}

/**
 * Parse RFC 3778 FragmentSelector value
 *
 * @param fragment - Fragment string like "page=5&viewrect=100,200,300,400"
 * @returns Parsed PDF coordinates or null if invalid
 */
export function parseFragmentSelector(fragment: string): PdfCoordinate | null {
  try {
    // Parse page number
    const pageMatch = fragment.match(/page=(\d+)/);
    if (!pageMatch) return null;
    const page = parseInt(pageMatch[1], 10);

    // Parse viewrect coordinates
    const viewrectMatch = fragment.match(/viewrect=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
    if (!viewrectMatch) return null;

    return {
      page,
      x: parseFloat(viewrectMatch[1]),
      y: parseFloat(viewrectMatch[2]),
      width: parseFloat(viewrectMatch[3]),
      height: parseFloat(viewrectMatch[4])
    };
  } catch {
    return null;
  }
}

/**
 * Extract page number from FragmentSelector
 */
export function getPageFromFragment(fragment: string): number | null {
  const match = fragment.match(/page=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
