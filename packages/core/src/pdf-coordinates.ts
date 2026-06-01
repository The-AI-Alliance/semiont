/**
 * PDF viewrect FragmentSelector codec.
 *
 * `PdfCoordinate` is a bounding rectangle in PDF point space: origin at the
 * bottom-left of the page, Y increasing upward. The Y-flip to canvas pixels
 * lives in the browser (`react-ui`); the server has no canvas.
 *
 * These functions are the viewrect peer of the W3C `FragmentSelector` wrapper in
 * `web-annotation-utils`: they serialize/parse the RFC 3778
 * `page=N&viewrect=left,top,width,height` value. `@semiont/content` (geometry
 * from the text layer), `@semiont/jobs` (serialization at write time), and the
 * browser canvas all import them from here — no package reaches into the UI.
 *
 * RFC 3778 PDF Fragment Identifiers: https://tools.ietf.org/html/rfc3778
 */

/**
 * A bounding rectangle in PDF point coordinates.
 * Origin at the bottom-left of the page; Y increases upward.
 */
export interface PdfCoordinate {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Serialize a PdfCoordinate to an RFC 3778 FragmentSelector value.
 * Format: `page=N&viewrect=left,top,width,height` (all in PDF points).
 */
export function createFragmentSelector(coord: PdfCoordinate): string {
  return `page=${coord.page}&viewrect=${coord.x},${coord.y},${coord.width},${coord.height}`;
}

/**
 * Parse an RFC 3778 FragmentSelector value into PDF coordinates.
 * Returns null when the value is not a well-formed page + viewrect fragment.
 */
export function parseFragmentSelector(fragment: string): PdfCoordinate | null {
  const pageMatch = fragment.match(/page=(\d+)/);
  if (!pageMatch) return null;

  // Each coordinate: optional sign, integer part, optional fraction — tight enough
  // to round-trip negatives and reject malformed numbers (e.g. "1.2.3").
  const viewrectMatch = fragment.match(
    /viewrect=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/
  );
  if (!viewrectMatch) return null;

  return {
    page: parseInt(pageMatch[1], 10),
    x: parseFloat(viewrectMatch[1]),
    y: parseFloat(viewrectMatch[2]),
    width: parseFloat(viewrectMatch[3]),
    height: parseFloat(viewrectMatch[4]),
  };
}

/** Extract the 1-indexed page number from a FragmentSelector value. */
export function getPageFromFragment(fragment: string): number | null {
  const match = fragment.match(/page=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
