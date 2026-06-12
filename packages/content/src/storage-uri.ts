/**
 * Storage URI Derivation
 *
 * Builds the file:// URI a resource lives at in the working tree from its
 * name and validated media type. Extensions come from the media-type
 * registry in @semiont/core; formats are validated upstream at the
 * create/yield boundary, so the lookup is strict — no fallback.
 */

import { MEDIA_TYPES, type SupportedMediaType } from '@semiont/core';

/**
 * Derive a file:// storage URI from a resource name and media type.
 *
 * The name is lowercased, runs of non-alphanumeric characters collapse to
 * single hyphens, and leading/trailing hyphens are stripped.
 *
 * @example
 * deriveStorageUri("My Document", "text/markdown") // => "file://my-document.md"
 */
export function deriveStorageUri(name: string, format: SupportedMediaType): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `file://${slug}${MEDIA_TYPES[format].extension}`;
}
