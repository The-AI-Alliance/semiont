/**
 * Where a resource's bytes are, and what type they are — decided ONCE.
 *
 * This join — `resourceId → view → storageUri + mediaType → bytes` — was
 * written out five times before SINGLE-KB-MOUNT P3, and the copies disagreed:
 * three different fallbacks for an absent media type, and two different
 * opinions about which field holds the URI. One copy was simply wrong —
 * `LocalContentTransport` resolved through `representations[].storageUri`,
 * which `ViewMaterializer` never writes, so binary reads threw for every
 * resource in local mode and nothing noticed.
 *
 * Every face now derives from here: the Archivist's HTTP content endpoint,
 * the in-process `ContentReads.getBinary`, the local transport, and the
 * preview paths. A sixth caller adds a call, never a second resolution.
 */

import { getPrimaryRepresentation, type ResourceDescriptor, type ResourceId } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';
// The failure is `@semiont/content`'s: the Archivist's HTTP client raises the
// same one for the same fact, and a caller must not be able to tell which
// side of the wire it came from (SINGLE-KB-MOUNT P4).
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
 * `storageUri` is read from the descriptor's own field because that is the
 * only one anything writes: `ViewMaterializer` sets `resource.storageUri` on
 * `yield:created` and `yield:moved`, while the `Representation` it builds
 * carries mediaType, checksum, byteSize, rel and language — never a URI.
 * (`Representation.storageUri` also exists in the schema and is dead; the
 * two-homed field is deferred, see SINGLE-KB-MOUNT P3.)
 *
 * `null` means "no bytes", which is a fact about the resource and not an
 * error — a descriptor without a URI is the has-content signal every caller
 * used before, kept.
 */
export function representationSource(resource: ResourceDescriptor | undefined): RepresentationSource | null {
  if (!resource?.storageUri) return null;
  return {
    storageUri: resource.storageUri,
    // A representation always declares its mediaType (the schema requires
    // it), so this fallback fires only for a descriptor carrying a URI and no
    // representation at all. One fallback, stated once: octet-stream is what
    // the wire serves for unknown bytes, and `decodeRepresentation` reads
    // only `charset=` so text callers decode identically either way.
    mediaType: getPrimaryRepresentation(resource)?.mediaType ?? 'application/octet-stream',
  };
}

export interface RepresentationReads {
  views: Pick<ViewStorage, 'get'>;
  content: Pick<WorkingTreeStore, 'retrieveStream'>;
}

/**
 * The whole resolution: a resource's bytes as a stream, with their stored
 * media type. Streams rather than buffers because the Archivist serves
 * content for every reader in the fleet (D7), so its memory must be bounded
 * by the chunk and not by the largest representation anyone asks for.
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
