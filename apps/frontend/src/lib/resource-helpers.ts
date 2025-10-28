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
