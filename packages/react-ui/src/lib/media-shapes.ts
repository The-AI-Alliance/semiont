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
 * The registry's anchoring model decides, never the type name: a spatially
 * anchored medium draws what its renderer can carry — rectangles only for
 * PDF (FragmentSelector, RFC 3778 viewrect; circle and polygon would need an
 * SvgSelector, which loses page context), all three for images (SvgSelector).
 * Everything else draws nothing — text media anchor by character offsets and
 * no selector there can carry a shape, and storage-tier rows are not
 * annotated at all.
 *
 * @param mediaType - MIME type of the resource (e.g., 'application/pdf', 'image/png')
 * @returns Array of supported shape types for annotation
 */
export function getSupportedShapes(mediaType: string | undefined | null): ShapeType[] {
  if (!mediaType) {
    // Unknown medium: don't advertise drawing capability it may not have.
    return [];
  }

  const caps = capabilitiesOf(mediaType);
  if (caps?.anchoring === 'spatial') {
    if (caps.render === 'pdf') return ['rectangle'];
    if (caps.render === 'image') return ['rectangle', 'circle', 'polygon'];
  }

  // Everything else: text anchoring (no selector carries a shape), storage-tier
  // rows, and registry misses. Stated as a positive whitelist with a catch-all
  // ON PURPOSE — the negative form (`caps?.anchoring !== 'none'`) answers true
  // on a miss, and an unregistered type must not be handed drawing tools.
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
 * Get the selector type used for a given media type.
 *
 * Keyed off the registry's anchoring model, in step with
 * `getSupportedShapes`: spatial + PDF render → FragmentSelector (RFC 3778),
 * spatial + image render → SvgSelector.
 *
 * Everything else answers 'text' — text media because they genuinely anchor
 * by character offset, storage-tier rows and registry misses because
 * `SelectorType` has no "not annotatable" member. That catch-all is harmless
 * rather than a claim: `getSupportedShapes` offers those types no shapes, and
 * the write path refuses them outright (MEDIA-CAPABILITY-DISPATCH D6).
 *
 * @param mediaType - MIME type of the resource
 * @returns Selector type (fragment, svg, or text)
 */
export function getSelectorType(mediaType: string | undefined | null): SelectorType {
  if (!mediaType) {
    return 'text'; // Default fallback
  }

  const caps = capabilitiesOf(mediaType);
  if (caps?.anchoring === 'spatial') {
    if (caps.render === 'pdf') return 'fragment';
    if (caps.render === 'image') return 'svg';
  }

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
