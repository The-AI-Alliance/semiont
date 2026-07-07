/**
 * Media Type Shape Support
 *
 * Defines which annotation shapes are supported for each media type.
 * Shapes are tracked per selector type (FragmentSelector, SvgSelector).
 */

import type { ShapeType } from '../components/annotation/AnnotateToolbar';
import { capabilitiesOf } from '@semiont/core';
/**
 * Selector types that support shape selection
 */
export type SelectorType = 'fragment' | 'svg' | 'text';

/**
 * Get supported annotation shapes for a given media type.
 *
 * This set is the host-facing CONTRACT for "which shapes can this medium
 * draw" — gate shape UI on it directly.
 *
 * PDF: only rectangles (FragmentSelector with RFC 3778 viewrect).
 * Images: all shapes (SvgSelector supports rect, circle, polygon).
 * Everything else — including text media and absent/unknown types — supports
 * NONE: those anchor by character offsets (TextPositionSelector /
 * TextQuoteSelector), and no selector can carry a shape. Mirrors
 * `getSelectorType`'s 'text' fallback.
 *
 * @param mediaType - MIME type of the resource (e.g., 'application/pdf', 'image/png')
 * @returns Array of supported shape types for annotation
 */
export function getSupportedShapes(mediaType: string | undefined | null): ShapeType[] {
  if (!mediaType) {
    // Unknown medium: don't advertise drawing capability it may not have.
    return [];
  }

  // PDF only supports rectangles via FragmentSelector (RFC 3778)
  // Circle and polygon would require SvgSelector, which loses page context
  if (capabilitiesOf(mediaType)?.render === 'pdf') {
    return ['rectangle'];
  }

  // Images support all shapes via SvgSelector
  if (mediaType.startsWith('image/')) {
    return ['rectangle', 'circle', 'polygon'];
  }

  // Text (and everything else) anchors by character offsets — there is no
  // selector to carry a shape, so the medium supports none.
  return [];
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

/**
 * Get the selector type used for a given media type
 *
 * @param mediaType - MIME type of the resource
 * @returns Selector type (fragment, svg, or text)
 */
export function getSelectorType(mediaType: string | undefined | null): SelectorType {
  if (!mediaType) {
    return 'text'; // Default fallback
  }

  // PDF uses FragmentSelector (RFC 3778)
  if (capabilitiesOf(mediaType)?.render === 'pdf') {
    return 'fragment';
  }

  // Images use SvgSelector
  if (mediaType.startsWith('image/')) {
    return 'svg';
  }

  // Text and other formats use TextPositionSelector/TextQuoteSelector
  return 'text';
}

/**
 * Get the selected shape for a given selector type from localStorage
 *
 * @param selectorType - The selector type
 * @returns The selected shape, or default for that selector type
 */
export function getSelectedShapeForSelectorType(selectorType: SelectorType): ShapeType {
  // Fragment selector only supports rectangle
  if (selectorType === 'fragment') {
    return 'rectangle';
  }

  // Text selectors don't use shapes
  if (selectorType === 'text') {
    return 'rectangle'; // Unused, but return default
  }

  // SVG selector: check localStorage
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('semiont-toolbar-shape-svg');
    if (stored && ['rectangle', 'circle', 'polygon'].includes(stored)) {
      return stored as ShapeType;
    }
  }

  // Default for SVG
  return 'rectangle';
}

/**
 * Save the selected shape for a given selector type to localStorage
 *
 * @param selectorType - The selector type
 * @param shape - The shape to save
 */
export function saveSelectedShapeForSelectorType(selectorType: SelectorType, shape: ShapeType): void {
  // Only save for SVG selector (fragment is always rectangle, text doesn't use shapes)
  if (selectorType === 'svg' && typeof window !== 'undefined') {
    localStorage.setItem('semiont-toolbar-shape-svg', shape);
  }
}
