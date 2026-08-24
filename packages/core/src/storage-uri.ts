/**
 * Storage URI Derivation
 *
 * Builds the name a resource's content lives under in the working tree, from
 * its title and validated media type. Extensions come from the media-type
 * registry; formats are validated upstream at the create/yield boundary, so
 * the lookup is strict — no fallback.
 *
 * Lives in `@semiont/core` rather than `@semiont/content` (moved
 * 2026-08-24, GENERATION-OUTPUT-FORMAT D10) because the generation form
 * proposes a default path and react-ui cannot depend on the node-flavoured
 * content package. This module imports only the registry, so it is
 * browser-safe.
 */

import { MEDIA_TYPES, type SupportedMediaType } from './media-types';

/**
 * The FILENAME a resource's content takes: slug + the registry's extension.
 *
 * The name is lowercased, runs of non-alphanumeric characters collapse to
 * single hyphens, and leading/trailing hyphens are stripped.
 *
 * This is the fragment form, for callers composing a path themselves — the
 * generation form's input sits beside a `file://` prefix chip, so it must not
 * strip a prefix this helper just added.
 *
 * @example
 * storageFileName("My Document", "text/markdown") // => "my-document.md"
 */
export function storageFileName(name: string, format: SupportedMediaType): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug}${MEDIA_TYPES[format].extension}`;
}

/**
 * Derive a full `file://` storage URI from a resource name and media type.
 *
 * @example
 * deriveStorageUri("My Document", "text/markdown") // => "file://my-document.md"
 */
export function deriveStorageUri(name: string, format: SupportedMediaType): string {
  return `file://${storageFileName(name, format)}`;
}

/**
 * The folder a resource lives in, WITHOUT a trailing slash — `''` when it sits
 * at the tree root. Accepts a `file://` URI or a bare path.
 */
export function folderOf(storageUri: string | undefined): string {
  const path = (storageUri ?? '').replace(/^file:\/\//, '');
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * The Save location a form PROPOSES: beside the source resource, named for the
 * title, extended for the chosen format (GENERATION-OUTPUT-FORMAT D11).
 *
 * Deriving the whole filename — extension included — has a happy consequence:
 * while untouched, switching format rewrites the extension too, so D7's
 * mismatch refusal becomes unreachable except on hand-edited paths. It guards
 * deliberate edits rather than trapping ordinary use.
 *
 * Returns `''` for an empty title: a bare extension (".md") reads as a hidden
 * file and is nobody's intent.
 */
export function proposeStoragePath(
  folder: string,
  title: string,
  format: SupportedMediaType,
): string {
  const name = storageFileName(title, format);
  if (name === MEDIA_TYPES[format].extension) return '';
  return folder ? `${folder}/${name}` : name;
}
