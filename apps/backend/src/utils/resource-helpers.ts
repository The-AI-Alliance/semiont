/**
 * Resource Helper Functions
 *
 * Utilities for working with W3C ResourceDescriptor schema
 * Provides safe property access and conversions
 */

import type { components } from '@semiont/api-client';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type Representation = components['schemas']['Representation'];

/**
 * Get resource ID from ResourceDescriptor
 * Extracts the ID portion from @id URI
 *
 * @param resource - ResourceDescriptor
 * @returns ID string (e.g., "doc-123" from "urn:semiont:resource:doc-123")
 */
export function getResourceId(resource: ResourceDescriptor): string {
  const id = resource['@id'];
  // Extract ID from URN format: urn:semiont:resource:doc-123
  if (id.startsWith('urn:semiont:resource:')) {
    return id.replace('urn:semiont:resource:', '');
  }
  // Extract ID from URL format: https://api.semiont.com/resources/doc-123
  if (id.includes('/')) {
    const parts = id.split('/');
    return parts[parts.length - 1] || id;
  }
  return id;
}

/**
 * Get primary (original) representation from ResourceDescriptor
 *
 * @param resource - ResourceDescriptor
 * @returns Primary Representation or undefined
 */
export function getPrimaryRepresentation(resource: ResourceDescriptor): Representation | undefined {
  const reps = Array.isArray(resource.representations)
    ? resource.representations
    : resource.representations ? [resource.representations] : [];

  return reps.find(r => r.rel === 'original') || reps[0];
}

/**
 * Get media type from primary representation
 *
 * @param resource - ResourceDescriptor
 * @returns Media type string or undefined
 */
export function getPrimaryMediaType(resource: ResourceDescriptor): string | undefined {
  const rep = getPrimaryRepresentation(resource);
  return rep?.mediaType;
}

/**
 * Get language from primary representation
 *
 * @param resource - ResourceDescriptor
 * @returns Language code or undefined
 */
export function getLanguage(resource: ResourceDescriptor): string | undefined {
  const rep = getPrimaryRepresentation(resource);
  return rep?.language;
}

/**
 * Get checksum from primary representation
 *
 * @param resource - ResourceDescriptor
 * @returns Checksum string or undefined
 */
export function getChecksum(resource: ResourceDescriptor): string | undefined {
  const rep = getPrimaryRepresentation(resource);
  return rep?.checksum;
}

/**
 * Get storage URI from primary representation
 *
 * @param resource - ResourceDescriptor
 * @returns Storage URI or undefined
 */
export function getStorageUri(resource: ResourceDescriptor): string | undefined {
  const rep = getPrimaryRepresentation(resource);
  return rep?.storageUri;
}

/**
 * Get creator agent from wasAttributedTo
 * Handles both single agent and array of agents
 *
 * @param resource - ResourceDescriptor
 * @returns First agent or undefined
 */
export function getCreator(resource: ResourceDescriptor): components['schemas']['Agent'] | undefined {
  if (!resource.wasAttributedTo) return undefined;

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
export function getDerivedFrom(resource: ResourceDescriptor): string | undefined {
  if (!resource.wasDerivedFrom) return undefined;

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
export function isArchived(resource: ResourceDescriptor): boolean {
  return resource.archived === true;
}

/**
 * Get entity types (application-specific field)
 *
 * @param resource - ResourceDescriptor
 * @returns Array of entity types, empty if not set
 */
export function getEntityTypes(resource: ResourceDescriptor): string[] {
  return resource.entityTypes || [];
}

/**
 * Check if resource is a draft (application-specific field)
 *
 * @param resource - ResourceDescriptor
 * @returns True if draft, false otherwise
 */
export function isDraft(resource: ResourceDescriptor): boolean {
  return resource.isDraft === true;
}
