/**
 * The gateway records what a person is CALLED, from the token it just
 * verified, at the moment that person WRITES (PERSON-PROFILE).
 *
 * The issuer's `name` claim is as verified as the DID stamped beside it, and
 * until this existed the gateway threw it away — leaving every artifact
 * attributed to a bare UUID, because a DID's subject is all `didToAgent` has.
 *
 * Two things this is deliberately NOT:
 *
 *  - **Not part of the record of an act.** The name goes to its own system
 *    event and no artifact carries a copy. Readers resolve it from the people
 *    projection, which is what lets a correction reach everything its subject
 *    ever wrote instead of freezing the old name in each artifact.
 *  - **Not a record of presence.** Being stamped with `_userId` is NOT the
 *    test for an act: a `browse:*` request carries one too. The test is
 *    whether the emit WRITES, which the bus registry's `effect` axis answers
 *    per channel and `channelWrites` reads. Someone who signs in and only
 *    reads is never named in the log, because they did nothing the log is
 *    about (PERSON-PROFILE D3).
 */

import { didToAgent } from '@semiont/core';
import type { Principal } from './principal';

/**
 * How the frame LEAVES this process — `plane.ingest`, the same dispatch
 * `/bus/emit` gives every other command.
 *
 * Not the per-process `EventBus`: under `[signal] type = "nats"` the Stower is
 * in the Archivist, and a raw bus emit never leaves the gateway. A profile
 * published that way is silently lost on every real deployment while passing
 * every in-process test — the yield:create starvation shape (2026-09-15),
 * observed here on a live stack before this seam existed.
 */
export type PublishFrame = (channel: 'person:profile', payload: { _userId: string; name: string }) => unknown;

/**
 * Publish this person's name, for a write they are making.
 *
 * **There is deliberately no de-dup cache here.** An earlier version kept one,
 * keyed by DID and set at the moment of publish — which records "I sent a
 * frame", never "the Stower has it". The two differ whenever a frame does not
 * arrive, and on a live stack one did not: a publish landed while the
 * Archivist was still re-subscribing after a gateway restart, the frame was
 * dropped, the cache was set, and that person was suppressed for the whole
 * life of the gateway process. Neither side retries, so it never heals.
 *
 * The Stower's compare-to-latest is the only de-dup, and it is authoritative
 * because it reads the log it is about to append to. Gating on writes is what
 * keeps that affordable: the publish rate becomes the write rate, which is
 * orders of magnitude below the rate of emits in general.
 *
 * Silent for an agent (a gateway-minted token names a model, not a person)
 * and for a token carrying no name — absence is recorded as absence, and the
 * issuer is where a name is set.
 */
export function profileOnce(principal: Principal | undefined, publish: PublishFrame): void {
  if (!principal?.name) return;
  // `didToAgent` already owns "what kind of DID is this"; asking it is one
  // reader of that rule rather than a second parser that can disagree.
  if (didToAgent(principal.did)['@type'] !== 'Person') return;

  publish('person:profile', { _userId: String(principal.did), name: principal.name });
}
