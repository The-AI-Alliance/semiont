/**
 * Helper functions for working with W3C ResourceDescriptor
 */

import type { components } from '@semiont/api-client';

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
