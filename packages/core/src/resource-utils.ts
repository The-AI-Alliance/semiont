/**
 * Helper functions for working with W3C ResourceDescriptor
 */

import type { components } from './types';
import type { ResourceDescriptor } from './graph';
import type { ResourceId } from './identifiers';
import { derivesTextOf, textSourceOf } from './media-types';
import { decodeWithCharset } from './text-encoding';

type Representation = components['schemas']['Representation'];

/**
 * Get the resource ID from @id property
 *
 * @id is always a bare ID (UUID), never a full URI.
 */
export function getResourceId(resource: ResourceDescriptor | undefined): ResourceId | undefined {
  if (!resource) return undefined;
  return resource['@id'] || undefined;
}

/**
 * Get the primary representation (first or only representation)
 */
export function getPrimaryRepresentation(resource: ResourceDescriptor | undefined): Representation | undefined {
  if (!resource?.representations) return undefined;
  const reps = Array.isArray(resource.representations)
    ? resource.representations
    : [resource.representations];
  return reps[0];
}

/**
 * Get the media type from the primary representation
 */
export function getPrimaryMediaType(resource: ResourceDescriptor | undefined): string | undefined {
  return getPrimaryRepresentation(resource)?.mediaType;
}

/**
 * Get the checksum from the primary representation
 */
export function getChecksum(resource: ResourceDescriptor | undefined): string | undefined {
  return getPrimaryRepresentation(resource)?.checksum;
}

/**
 * Get the language from the primary representation
 */
export function getLanguage(resource: ResourceDescriptor | undefined): string | undefined {
  return getPrimaryRepresentation(resource)?.language;
}

/**
 * Get the storage URI from the primary representation — the field's ONE
 * home: bytes are a fact about a rendition, so their location lives on the
 * Representation, never on the descriptor. This is the accessor every
 * descriptor-holding read goes through; `undefined` means the resource has no
 * stored bytes.
 *
 * @param resource - ResourceDescriptor
 * @returns Storage URI or undefined
 */
export function getStorageUri(resource: ResourceDescriptor | undefined): string | undefined {
  return getPrimaryRepresentation(resource)?.storageUri;
}

/**
 * Get creator agent from wasAttributedTo
 * Handles both single agent and array of agents
 *
 * @param resource - ResourceDescriptor
 * @returns First agent or undefined
 */
export function getCreator(resource: ResourceDescriptor | undefined): components['schemas']['Agent'] | undefined {
  if (!resource?.wasAttributedTo) return undefined;

  return Array.isArray(resource.wasAttributedTo)
    ? resource.wasAttributedTo[0]
    : resource.wasAttributedTo;
}

/**
 * Get derived-from URI
 * Handles both single URI and array of URIs
 *
 * @param resource - ResourceDescriptor
 * @returns First derivation URI or undefined
 */
export function getDerivedFrom(resource: ResourceDescriptor | undefined): string | undefined {
  if (!resource?.wasDerivedFrom) return undefined;

  return Array.isArray(resource.wasDerivedFrom)
    ? resource.wasDerivedFrom[0]
    : resource.wasDerivedFrom;
}

/**
 * Check if resource is archived (application-specific field)
 *
 * @param resource - ResourceDescriptor
 * @returns True if archived, false otherwise
 */
export function isArchived(resource: ResourceDescriptor | undefined): boolean {
  return resource?.archived === true;
}

/**
 * Get entity types from resource (application-specific field)
 *
 * @param resource - ResourceDescriptor
 * @returns Array of entity types, empty if not set
 */
export function getResourceEntityTypes(resource: ResourceDescriptor | undefined): string[] {
  return resource?.entityTypes || [];
}

/**
 * Check if resource is a draft (application-specific field)
 *
 * @param resource - ResourceDescriptor
 * @returns True if draft, false otherwise
 */
export function isDraft(resource: ResourceDescriptor | undefined): boolean {
  return resource?.isDraft === true;
}

/**
 * A representation's bytes as the text they are, for a media type whose bytes
 * are its text. The reading is `decodeWithCharset`'s, which keeps the rule
 * every reader of a resource's text keeps (docs/protocol/W3C-SELECTORS.md,
 * "The text of a resource"). An offset counts the code points of this text,
 * so every reader makes the same text of the same bytes.
 *
 * @param buffer - The raw representation data
 * @param mediaType - Media type with optional charset (e.g., "text/plain; charset=iso-8859-1")
 * @returns Decoded string
 * @throws For a media type whose bytes are not its text, and for a charset that is not decoded
 *
 * @example
 * ```typescript
 * const content = decodeRepresentation(buffer, "text/plain; charset=utf-8");
 * const legacy = decodeRepresentation(buffer, "text/plain; charset=windows-1252");
 * ```
 */
export function decodeRepresentation(buffer: Buffer, mediaType: string): string {
  // The chokepoint gate: decoding is only legitimate for media whose bytes
  // ARE its text — not for derived-text media (the anchored-text read answers
  // those) and not for media with no text at all. A PDF decoded here would
  // become megabytes of mojibake; refusing means no caller — present or
  // future — can decode bytes that were never text, which is why this gate
  // supersedes a caller census. Category, not mechanism: a
  // new strategy declares its side in core's exhaustive category maps and
  // this gate follows automatically.
  const source = textSourceOf(mediaType);
  if (derivesTextOf(mediaType) || source === 'none') {
    throw new Error(
      `decodeRepresentation refused ${mediaType}: its text source is '${source}' — ` +
      `derived text comes from the anchored-text read, never from decoding bytes`,
    );
  }

  return decodeWithCharset(buffer, mediaType);
}

/**
 * Newest first, ties broken by id — the ordering every listing of resources carries,
 * whether the views answer it or a graph engine does.
 *
 * The tiebreak is not cosmetic: browse pages these results with offset/limit,
 * and a partial order lets two pages repeat or drop rows. Ids compare by code
 * point rather than locale so every producer agrees with the engines, whose
 * `ORDER BY` is codepoint-ordered.
 */
export function compareByRecencyThenId(a: ResourceDescriptor, b: ResourceDescriptor): number {
  const aTime = a.dateCreated ? Date.parse(a.dateCreated) : 0;
  const bTime = b.dateCreated ? Date.parse(b.dateCreated) : 0;
  if (aTime !== bTime) return bTime - aTime;
  const aId = String(a['@id']);
  const bId = String(b['@id']);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}
