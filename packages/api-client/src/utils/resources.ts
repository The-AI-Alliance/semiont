/**
 * Helper functions for working with W3C ResourceDescriptor
 */

import type { components } from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Representation = components['schemas']['Representation'];

/**
 * Get the resource ID from @id property
 *
 * For internal resources: extracts UUID from "http://localhost:4000/resources/{uuid}"
 * For external resources: returns undefined
 *
 * This is used for routing - the frontend URL should contain only the resource ID,
 * not the full HTTP URI.
 */
export function getResourceId(resource: ResourceDescriptor | undefined): string | undefined {
  if (!resource) return undefined;

  const fullId = resource['@id'];

  // For internal resources, extract the last path segment
  // http://localhost:4000/resources/{uuid} -> {uuid}
  if (fullId.includes('/resources/')) {
    const parts = fullId.split('/resources/');
    const lastPart = parts[parts.length - 1];
    return lastPart || undefined;
  }

  // For external resources, cannot extract ID
  return undefined;
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
 * Get storage URI from primary representation
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
 * Map charset names to Node.js Buffer encoding names
 * Node.js Buffer.toString() supports: 'utf8', 'utf16le', 'latin1', 'base64', 'hex', 'ascii', 'binary', 'ucs2'
 *
 * @param charset - Charset name (e.g., "UTF-8", "ISO-8859-1", "Windows-1252")
 * @returns Node.js BufferEncoding
 */
export function getNodeEncoding(charset: string): BufferEncoding {
  const normalized = charset.toLowerCase().replace(/[-_]/g, '');

  // Map common charset names to Node.js encodings
  const charsetMap: Record<string, BufferEncoding> = {
    'utf8': 'utf8',
    'iso88591': 'latin1',
    'latin1': 'latin1',
    'ascii': 'ascii',
    'usascii': 'ascii',
    'utf16le': 'utf16le',
    'ucs2': 'ucs2',
    'binary': 'binary',
    'windows1252': 'latin1', // Windows-1252 is a superset of Latin-1
    'cp1252': 'latin1',
  };

  return charsetMap[normalized] || 'utf8';
}

/**
 * Decode a representation buffer to string using the correct charset
 * Extracts charset from media type and uses appropriate encoding
 *
 * @param buffer - The raw representation data
 * @param mediaType - Media type with optional charset (e.g., "text/plain; charset=iso-8859-1")
 * @returns Decoded string
 *
 * @example
 * ```typescript
 * const content = decodeRepresentation(buffer, "text/plain; charset=utf-8");
 * const legacy = decodeRepresentation(buffer, "text/plain; charset=windows-1252");
 * ```
 */
export function decodeRepresentation(buffer: Buffer, mediaType: string): string {
  // Extract charset from mediaType (e.g., "text/plain; charset=iso-8859-1")
  const charsetMatch = mediaType.match(/charset=([^\s;]+)/i);
  const charset = (charsetMatch?.[1] || 'utf-8').toLowerCase();

  // Map to Node.js encoding
  const encoding = getNodeEncoding(charset);

  return buffer.toString(encoding);
}
