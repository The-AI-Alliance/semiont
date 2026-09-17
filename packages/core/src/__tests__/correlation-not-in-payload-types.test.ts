/**
 * BUS-CARRIES-FRAMES P4/D5 — the payload census is a TYPE, not a grep.
 *
 * The rule this enforces: `correlationId` is a routing fact that rides the
 * ENVELOPE, so no channel's payload type may declare it. A grep can be
 * satisfied by a rename; this cannot, and its failure names the offending
 * channel.
 *
 * It is also the gate that makes the ordinary form of the regression
 * impossible rather than merely absent. Once no `EventMap[K]` declares the
 * key, `handler(event) { event.correlationId }` is a type error at the point
 * it is written — which is the form every one of the nine echoing handlers
 * used before P3.
 *
 * **The predicate the plan originally specified was wrong, and would have
 * failed on a clean registry.** It read:
 *
 *     'correlationId' extends keyof EventMap[K] ? K : never
 *
 * `keyof Record<string, never>` is `string`, and `'correlationId' extends
 * string` is true — so it flagged `mark:archive-ok`, whose payload is
 * `Record<string, never>`: an EMPTY payload, which is the most correct a
 * reply channel can be. Landing it as written would have failed against a
 * clean tree and invited someone to "fix" it by making a correct channel
 * wrong. The structural test below asks the question that was actually meant:
 * does the payload SATISFY a carrier of the key?
 *
 * What this cannot see, stated so the next reader does not over-trust it:
 * reads through `unknown` or a cast, where no payload type is consulted at
 * all. Those are `correlation-not-read-from-payloads.test.ts`'s half.
 */

import { describe, it, expect } from 'vitest';
import type { EventMap } from '../bus-protocol';

/**
 * The channels whose payload type carries `correlationId`. Computed, not
 * listed — a new channel enrols itself.
 */
type ChannelsWithCidInPayload = {
  [K in keyof EventMap]: EventMap[K] extends { correlationId: unknown } ? K : never;
}[keyof EventMap];

/**
 * The census. Only `never` is assignable to `never`, so this line compiles
 * ONLY when the computed union is empty; a violation fails the typecheck with
 * `Type '"some:channel"' is not assignable to type 'never'`, naming it.
 *
 * Direction matters and is easy to get backwards. Written the other way round
 * — `const _: ChannelsWithCidInPayload = undefined as never` — it compiles
 * whatever the census computes, because `never` is assignable to everything,
 * and the gate passes a registry full of violations while looking identical.
 */
const _noPayloadCarriesCorrelation: never = undefined as never as ChannelsWithCidInPayload;

describe('no channel payload type declares correlationId (D5)', () => {
  it('is enforced by the assignment above, which fails the TYPECHECK, not this run', () => {
    // The gate is the `const` above: it is checked by `tsc --noEmit`, which
    // covers test files. This case exists so the rule is discoverable from the
    // suite listing too, and so `vitest` reports it as a named contract rather
    // than as an unreferenced type file.
    expect(_noPayloadCarriesCorrelation).toBeUndefined();
  });
});
