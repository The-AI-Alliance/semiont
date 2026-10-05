/**
 * Where a resource's bytes are, and what type they are — decided ONCE.
 *
 * This join — `resourceId → view → storageUri + mediaType → bytes` — is
 * decided in this one place: written out per caller, the copies drift apart
 * on the fallback for an absent media type and on which field holds the URI.
 *
 * Every face derives from here: the Archivist's HTTP content endpoint,
 * the in-process `ContentReads.getBinary`, the local transport, and the
 * preview paths. A new caller adds a call, never a second resolution.
 */

import { getPrimaryRepresentation, type ResourceDescriptor, type ResourceId } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';
// The failure is `@semiont/content`'s: the Archivist's HTTP client raises the
// same one for the same fact, and a caller must not be able to tell which
// side of the wire it came from.
import { RepresentationMissing, type WorkingTreeStore } from '@semiont/content';
import type { Readable } from 'stream';

/** A resource's bytes: where they live and what they are. */
export interface RepresentationSource {
  storageUri: string;
  mediaType: string;
}

/**
 * The descriptor half of the decision, for callers that already hold one.
 *
 * URI and mediaType come from the same object: the primary representation is
 * `storageUri`'s ONE home (bytes are a fact about a rendition, and
 * `ViewMaterializer` writes the URI there on `yield:created` and relocates
 * it on `yield:moved`). The descriptor has no URI field of its own, so a URI
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

export interface RepresentationReads {
  views: Pick<ViewStorage, 'get'>;
  content: Pick<WorkingTreeStore, 'retrieveStream'>;
}

/**
 * The whole resolution: a resource's bytes as a stream, with their stored
 * media type. Streams rather than buffers because the Archivist serves
 * content for every reader in the fleet, so its memory must be bounded by
 * the chunk and not by the largest representation anyone asks for.
 *
 * Throws `RepresentationMissing` when the view or the URI is absent — the two
 * cases are distinguished because clients see two different messages. A file
 * missing from the tree is neither: that is a broken working tree, and it
 * surfaces as a stream error rather than a 404 claiming the record is empty.
 */
export async function resolveRepresentation(
  deps: RepresentationReads,
  resourceId: ResourceId,
): Promise<{ stream: Readable; mediaType: string }> {
  const view = await deps.views.get(resourceId);
  if (!view?.resource) throw new RepresentationMissing(String(resourceId), 'resource');

  const source = representationSource(view.resource);
  if (!source) throw new RepresentationMissing(String(resourceId), 'representation');

  return { stream: deps.content.retrieveStream(source.storageUri), mediaType: source.mediaType };
}
