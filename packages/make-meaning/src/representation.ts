/**
 * Where a descriptor says a resource's bytes are, and what type they are —
 * decided ONCE. Written out per caller, the copies drift apart on the
 * fallback for an absent media type and on which field holds the URI.
 */

import { getPrimaryRepresentation, type ResourceDescriptor } from '@semiont/core';

/** A resource's bytes: where they live and what they are. */
export interface RepresentationSource {
  storageUri: string;
  mediaType: string;
}

/**
 * URI and mediaType come from the same object: the primary representation is
 * `storageUri`'s ONE home (bytes are a fact about a rendition, and the
 * Archivist writes the URI there on `yield:created` and relocates it on
 * `yield:moved`). The descriptor has no URI field of its own, so a URI
 * without a representation is not representable and no media-type fallback
 * exists for it.
 *
 * `null` means "no bytes", which is a fact about the resource and not an
 * error — a primary representation without a URI is the no-content signal.
 */
export function representationSource(resource: ResourceDescriptor | undefined): RepresentationSource | null {
  const primary = getPrimaryRepresentation(resource);
  if (!primary?.storageUri) return null;
  return {
    storageUri: primary.storageUri,
    mediaType: primary.mediaType,
  };
}
