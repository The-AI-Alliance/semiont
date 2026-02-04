/**
 * Media Type Shape Support
 *
 * Defines which annotation shapes are supported for each media type.
 */

import type { ShapeType } from '../components/annotation/AnnotateToolbar';
import { isPdfMimeType } from '@semiont/api-client';

/**
 * Get supported annotation shapes for a given media type
 *
 * PDF: Only rectangles (FragmentSelector with RFC 3778 viewrect)
 * Images: All shapes (SvgSelector supports rect, circle, polygon)
 *
 * @param mediaType - MIME type of the resource (e.g., 'application/pdf', 'image/png')
 * @returns Array of supported shape types for annotation
 */
export function getSupportedShapes(mediaType: string | undefined | null): ShapeType[] {
  if (!mediaType) {
    // Default: support all shapes
    return ['rectangle', 'circle', 'polygon'];
  }

  // PDF only supports rectangles via FragmentSelector (RFC 3778)
  // Circle and polygon would require SvgSelector, which loses page context
  if (isPdfMimeType(mediaType)) {
    return ['rectangle'];
  }

  // Images support all shapes via SvgSelector
  if (mediaType.startsWith('image/')) {
    return ['rectangle', 'circle', 'polygon'];
  }

  // Default for unknown types: all shapes
  return ['rectangle', 'circle', 'polygon'];
}

/**
 * Check if a shape type is supported for a given media type
 *
 * @param mediaType - MIME type of the resource
 * @param shape - Shape type to check
 * @returns true if the shape is supported for this media type
 */
export function isShapeSupported(
  mediaType: string | undefined | null,
  shape: ShapeType
): boolean {
  return getSupportedShapes(mediaType).includes(shape);
}
