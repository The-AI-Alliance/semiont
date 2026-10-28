/**
 * Helper functions for working with W3C ResourceDescriptor
 */

import type { components } from './types';
import { SemiontError } from './errors';
import type { TransportErrorCode } from './generated/error-codes';
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

/** Whether `value` is a representation as its schema has one: an object that states its media type as text. */
function isRepresentation(value: unknown): value is Representation {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'mediaType' in value && typeof value.mediaType === 'string';
}

/**
 * The primary representation: the only one, or the first of the list;
 * undefined for an empty list, or for no resource. A resource that states no
 * `representations`, or one that is neither one representation nor a list of
 * them, is no ResourceDescriptor and is refused, as the Rust and Python SDKs
 * refuse it when they decode it (specs/src/resources/reader-cases.json).
 */
export function getPrimaryRepresentation(resource: ResourceDescriptor | undefined): Representation | undefined {
  if (resource === undefined) return undefined;
  const stated: unknown = resource.representations;
  if (isRepresentation(stated)) return stated;
  if (Array.isArray(stated) && stated.every(isRepresentation)) return stated[0];
  throw new SemiontError(
    `The resource ${resource['@id']} is no ResourceDescriptor: its representations are ${stated === undefined ? 'not stated' : 'neither one representation nor a list of them'}`,
    'error' satisfies TransportErrorCode,
  );
}

/**
 * Get the media type from the primary representation. A resource that is no
 * ResourceDescriptor is refused, as getPrimaryRepresentation refuses it.
 */
export function getPrimaryMediaType(resource: ResourceDescriptor | undefined): string | undefined {
  return getPrimaryRepresentation(resource)?.mediaType;
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
 * A refusal is the reader's own failure, whichever it is of: a media type
 * whose bytes are not its text, or a charset that is not decoded.
 *
 * @param buffer - The raw representation data
 * @param mediaType - Media type with optional charset (e.g., "text/plain; charset=iso-8859-1")
 * @returns Decoded string
 * @throws A `SemiontError` whose code is `error`: naming the media type, for one whose bytes are not its text, and naming the charset, for one that is not decoded
 *
 * @example
 * ```typescript
 * const content = decodeRepresentation(buffer, "text/plain; charset=utf-8");
 * const legacy = decodeRepresentation(buffer, "text/plain; charset=windows-1252");
 * ```
 */
export function decodeRepresentation(buffer: ArrayBuffer | Uint8Array, mediaType: string): string {
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
    throw new SemiontError(
      `decodeRepresentation refused ${mediaType}: its text source is '${source}' — ` +
      `derived text comes from the anchored-text read, never from decoding bytes`,
      'error' satisfies TransportErrorCode,
    );
  }

  return decodeWithCharset(buffer, mediaType);
}
