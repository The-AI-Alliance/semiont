/**
 * Resource utilities
 * Shared helper functions for resource display and metadata
 */

import { baseMediaType, capabilitiesOf } from '@semiont/core';

/**
 * Get icon emoji based on media type.
 *
 * The icon is a pure file-kind UI concern — there is no icon field in the
 * core registry, and it intentionally does NOT track render capability:
 * every image gets the image glyph whether or not we can preview it. Only
 * the base type matters, normalized via the registry's `baseMediaType`.
 */
export function getResourceIcon(mediaType: string | undefined): string {
  if (!mediaType) return '📄';

  const base = baseMediaType(mediaType);
  if (base.startsWith('image/')) return '🖼️';
  switch (base) {
    case 'text/markdown':
      return '📝';
    case 'text/html':
      return '🌐';
    default:
      return '📄';
  }
}

/**
 * Check if a resource supports text-based AI detection features.
 *
 * Detection anchors on character-offset text selectors, so the gate is the
 * registry's anchoring model: true exactly for the text-selector types
 * (markdown, plain, html, json). Registry misses (imported foreign types)
 * are not offered detection in the UI.
 *
 * @param mediaType - The media type string (e.g., 'text/plain', 'text/markdown')
 * @returns true if the resource supports AI detection features
 */
export function supportsDetection(mediaType: string | undefined): boolean {
  if (!mediaType) return false;
  return capabilitiesOf(mediaType)?.anchoring === 'text-selector';
}
