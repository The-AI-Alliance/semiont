import type { UserId } from './identifiers';
import { userId } from './identifiers';

/**
 * Who a record is attributed to.
 *
 * A chain, not a choice. The shape this replaces was
 * `principalDid = agentDid ?? userToDid(user)` — an `??` that made the human
 * and the software peer alternatives, so agent traffic recorded the agent and
 * lost the person, and human traffic recorded the person and could not say
 * what carried the request. Everything downstream then reconciled the two by
 * hand: `@semiont/jobs` threads the initiating human through as a job payload
 * field while the worker's token names only the agent, and the annotation
 * builder rebuilds PROV-O `wasAttributedTo` from the pair.
 *
 * People and software agents are peers here, which is the whole point. They
 * hold the same kind of credential, reach the gateway through the same SDK,
 * and appear in this same shape — an agent is not a special case bolted onto
 * a human-shaped record. What differs between them is not their nature but
 * which leg of the chain they occupy in a given act.
 *
 * - `did` is the AUTHORITY the act was performed under. A person when work is
 *   delegated; the agent itself when it acts autonomously. It is never absent.
 * - `actor` is the software peer that actually performed it, when that differs
 *   from the authority. Absent when they are the same — see `principal()`.
 * - `client` is the application that carried the request.
 *
 * W3C PROV-shaped, and deliberately so: `did` is the association's agent,
 * `actor` the one it acted on behalf of, and a reader that knows PROV can read
 * a Semiont record without being taught a local vocabulary.
 */
export interface Principal {
  did: UserId;
  actor?: UserId;
  client?: UserId;
}

/**
 * Build a `Principal`, collapsing a self-delegation and validating every leg.
 *
 * The collapse is the invariant worth enforcing in one place: an autonomous
 * agent is the authority for its own work, and a record saying the weaver
 * acted on behalf of the weaver states a delegation that did not happen.
 * `@semiont/jobs` already performs this collapse by hand when it decides
 * whether `wasAttributedTo` names one party or two; doing it here means the
 * decision exists once and every reader inherits it.
 *
 * Absent legs are OMITTED, not set to `undefined`. These records are persisted
 * as JSON, where an explicit undefined does not survive the round trip as
 * itself — so absence is the only shape that reads back the way it was
 * written.
 */
export function principal(chain: {
  did: UserId;
  actor?: UserId;
  client?: UserId;
}): Principal {
  const did = userId(chain.did);
  const actor = chain.actor === undefined ? undefined : userId(chain.actor);
  const client = chain.client === undefined ? undefined : userId(chain.client);
  return {
    did,
    ...(actor !== undefined && actor !== did ? { actor } : {}),
    ...(client !== undefined ? { client } : {}),
  };
}
