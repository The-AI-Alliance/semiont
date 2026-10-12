/**
 * How gather reads a resource's DERIVED text — the anchored-text read.
 *
 * The Librarian asks the gateway, by the content transport made over its
 * `HttpTransport` (`GET /resources/:id/anchored-text`), and the gateway asks
 * the Archivist.
 *
 * This is the read-side half of "the media type decides where the text comes
 * from": `decode` media decode their own bytes; `pdf-text-layer` media answer
 * from here — the artifact the Smelter alone writes, served by the Archivist
 * from its read-only mount. Never from `decodeRepresentation`, which refuses
 * them.
 */

import type { AnchoredTextAnswer, IContentTransport, ResourceId } from '@semiont/core';

/** The gather reads' derived-text capability: resource id in, classified answer out. */
export type AnchoredTextAsk = (resourceId: ResourceId) => Promise<AnchoredTextAnswer>;

export function anchoredTextOverContent(content: Pick<IContentTransport, 'getAnchoredText'>): AnchoredTextAsk {
  return (resourceId) => content.getAnchoredText(resourceId);
}
