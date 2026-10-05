/**
 * How gather reads a resource's DERIVED text — the anchored-text bus read.
 *
 * One implementation for every process, because every process holds a
 * `BusRequestPrimitive` that reaches the Browser: the standalone root's and
 * the Archivist's local bus (the Browser is in-process), and the Librarian's
 * `HttpTransport` (SSE in, `/bus/emit` out; the Archivist answers — the
 * reply channels must be in its subscription set, which `busRequest`'s
 * probe enforces loudly at first use).
 *
 * This is the read-side half of "the media type decides where the text comes
 * from": `decode` media decode their own bytes; `pdf-text-layer` media answer
 * from here — the artifact the Smelter alone writes, served by the Archivist
 * from its read-only mount. Never from `decodeRepresentation`, which refuses
 * them.
 */

import { busRequest, type AnchoredTextAnswer, type BusOperationKey, type BusRequestPrimitive } from '@semiont/core';

/** The gather reads' derived-text capability: resource id in, classified answer out. */
export type AnchoredTextAsk = (resourceId: string) => Promise<AnchoredTextAnswer>;

/** The declared await (the service-channels census pattern): a transport
 *  carrying this ask must subscribe this operation's reply channels. */
const ANCHORED_TEXT_ASK_OPERATION = 'browse:anchored-text-requested' satisfies BusOperationKey;
export type AnchoredTextAskAwaits = typeof ANCHORED_TEXT_ASK_OPERATION;

export function anchoredTextOverBus(bus: BusRequestPrimitive): AnchoredTextAsk {
  return (resourceId) => busRequest(bus, ANCHORED_TEXT_ASK_OPERATION, { resourceId });
}
