/**
 * Helper functions for working with W3C ResourceDescriptor
 */

import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Representation = components['schemas']['Representation'];

/**
 * Get the resource ID from @id property
 */
export function getResourceId(resource: ResourceDescriptor | undefined): string {
  if (!resource) return '';
  return resource['@id'];
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
 * Extract the document ID from a ResourceDescriptor's @id
 *
 * For internal documents: extracts "doc-sha256:..." from "http://localhost:4000/documents/doc-sha256:..."
 * For external documents: returns the full URI as-is
 *
 * This is used for routing - the frontend URL should contain only the document ID,
 * not the full HTTP URI.
 */
export function getDocumentId(resource: ResourceDescriptor | undefined): string {
  if (!resource) return '';

  const fullId = resource['@id'];

  // For internal documents, extract the last path segment
  // http://localhost:4000/documents/doc-sha256:... -> doc-sha256:...
  if (fullId.includes('/documents/')) {
    const parts = fullId.split('/documents/');
    const lastPart = parts[parts.length - 1];
    return lastPart || fullId; // Fallback to fullId if split fails
  }

  // For external resources, return the full URI
  return fullId;
}
