/**
 * The gateway records what a person is CALLED, from the token it just
 * verified, at the moment that person ACTS (PERSON-PROFILE).
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
 *  - **Not a record of presence.** It fires where the gateway stamps
 *    `_userId` — on an act — and never from the auth middleware. Someone who
 *    signs in and only reads is never named in the log, because they did
 *    nothing the log is about (PERSON-PROFILE D3).
 */

import type { EventBus } from '@semiont/core';
import { didToAgent } from '@semiont/core';
import type { Principal } from './principal';

/**
 * The last name this process told the Stower about, per DID.
 *
 * A cheap in-memory approximation of the Stower's own compare-to-latest, and
 * it exists to spare the Stower a system-log read per act: a person's access
 * token lives 300 s, so an hour of work is a dozen tokens and potentially
 * hundreds of acts, all carrying the same name.
 *
 * The LAST name, not a set of names seen. A set would swallow a rename back
 * to an earlier name — A → B → A would emit twice and the log would end at B,
 * which is the wrong answer written permanently. One entry per person who has
 * acted since boot, which is bounded by the people who use this knowledge
 * base.
 *
 * Being an approximation is safe in both directions. A restart or a second
 * replica emits again; the Stower compares against the log and appends
 * nothing. Nothing here is authoritative, and nothing downstream trusts it.
 */
const lastProfiled = new Map<string, string>();

/** Test seam: the cache is process state, and a test that cannot clear it leaks into the next. */
export function resetProfileCache(): void {
  lastProfiled.clear();
}

/**
 * Emit `person:profile` if this person's name is news.
 *
 * Called beside the `_userId` injection, so "acts" needs no separate
 * definition: if the gateway is stamping an identity onto something, that is
 * an act. Silent for an agent (a gateway-minted token names a model, not a
 * person) and for a token that carries no name — absence is recorded as
 * absence, and the issuer is where a name is set.
 */
export function profileOnce(principal: Principal | undefined, eventBus: EventBus): void {
  if (!principal?.name) return;
  // `didToAgent` already owns "what kind of DID is this"; asking it is one
  // reader of that rule rather than a second parser that can disagree.
  if (didToAgent(principal.did)['@type'] !== 'Person') return;

  const did = String(principal.did);
  if (lastProfiled.get(did) === principal.name) return;
  lastProfiled.set(did, principal.name);

  eventBus.emit('person:profile', { _userId: did, name: principal.name } as never);
}
