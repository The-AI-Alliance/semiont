/**
 * The KB's software-agent roster, derived from the SAME config sections that
 * route work (COLLABORATOR-DIRECTORY D3): `workers.*` per job type plus
 * `actors.*`. This is the DECLARED roster — "who CAN work" — deliberately not
 * the auth upsert history ("who has worked") and not liveness/presence.
 *
 * Capabilities resolve through `resolveWorkerInference` — the same
 * specific→default resolution the workers apply — so the roster matches
 * runtime routing by construction: a `workers.default`-only agent serves
 * every job type not explicitly assigned elsewhere, and 'default' itself is
 * config vocabulary, never a JobType in the reply.
 *
 * The DID domain is the KB's committed `[site] domain` — its identity, the
 * SAME value `/api/tokens/agent` mints worker DIDs from. One value, one owner:
 * the roster consumes it verbatim and derives nothing from topology
 * (deriving from `publicURL`/connection URLs produced one logical agent
 * with two DIDs — .plans/bugs/agent-did-host-skew.md; the P5 attribution
 * cross-check arbitrates the equality).
 */

import { softwareToAgent } from '@semiont/core';
import type { components } from '@semiont/core';
import { resolveActorInference, resolveWorkerInference, type RoleInference, type RosterConfig, type WorkerInferenceConfig } from './config';

type Agent = components['schemas']['Agent'];
type CollaboratorEntry = components['schemas']['CollaboratorEntry'];
type JobType = components['schemas']['JobType'];

// The concrete job types = WorkerInferenceConfig's keys minus 'default'.
const JOB_TYPES = [
  'reference-annotation',
  'highlight-annotation',
  'assessment-annotation',
  'comment-annotation',
  'tag-annotation',
  'generation',
] as const satisfies readonly (JobType & keyof Omit<WorkerInferenceConfig, 'default'>)[];

/** The roster's dedup key — with one domain per KB, this pair IS the DID
 *  (COLLABORATOR-DIRECTORY D4). */
const inferencePairKey = (provider: string, model: string): string => `${provider} ${model}`;

/**
 * The one walk over the config sections that route work: every role the
 * roster admits, in roster order (workers by job type, then actors).
 */
function eachAdmittedInference(
  config: RosterConfig,
  visit: (inference: RoleInference, jobType?: JobType) => void,
): void {
  for (const jobType of JOB_TYPES) {
    try {
      visit(resolveWorkerInference(config, jobType), jobType);
    } catch {
      // The resolver throws only for "unconfigured" — no declared worker
      // serves this job type: skip, don't fail.
    }
  }
  for (const actor of ['gatherer', 'matcher'] as const) {
    try {
      visit(resolveActorInference(config, actor));
    } catch {
      // Actor not configured — not on the roster.
    }
  }
}

export function deriveAgentRoster(config: RosterConfig, domain: string | undefined): CollaboratorEntry[] {
  if (!domain) {
    throw new Error(
      "The knowledge base's committed .semiont/config declares no [site] domain, and agent DIDs are minted under it — the same domain /api/tokens/agent mints worker DIDs from (no topology fallback)",
    );
  }

  // Dedup by (provider, model) — with one domain per KB, that is the DID.
  const roster = new Map<string, { agent: Agent; servesJobTypes: JobType[] }>();
  eachAdmittedInference(config, (inference, jobType) => {
    const key = inferencePairKey(inference.type, inference.model);
    let entry = roster.get(key);
    if (!entry) {
      entry = {
        agent: softwareToAgent({ domain, provider: inference.type, model: inference.model }),
        servesJobTypes: [],
      };
      roster.set(key, entry);
    }
    if (jobType) entry.servesJobTypes.push(jobType);
  });

  return [...roster.values()].map(({ agent, servesJobTypes }) =>
    servesJobTypes.length ? { agent, servesJobTypes } : { agent },
  );
}
