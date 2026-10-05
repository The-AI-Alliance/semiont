/**
 * The KB's software-agent roster: the DECLARED roster — "who CAN work" —
 * deliberately not the auth upsert history ("who has worked") and not
 * liveness/presence.
 *
 * It is the configuration document's `roster`: each role's provider and
 * model, with every fallback the knowledge base's config allows already
 * applied by whoever wrote the document. The same resolution routes the
 * work, so the roster matches runtime routing: an agent serving several job
 * types is listed once, with all of them.
 *
 * The DID domain is the KB's committed `[site] domain` — its identity, the
 * SAME value `/api/tokens/agent` mints worker DIDs from. One value, one owner:
 * the roster consumes it verbatim and derives nothing from topology
 * (deriving from `publicURL`/connection URLs produced one logical agent
 * with two DIDs; the live-stack attribution cross-check — every `generator`
 * stamped on a created annotation is a member of this roster — arbitrates
 * the equality).
 */

import { softwareToAgent } from '@semiont/core';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];
type CollaboratorEntry = components['schemas']['CollaboratorEntry'];
type JobType = components['schemas']['JobType'];
export type Roster = components['schemas']['ArchivistRoster'];
type RosterRole = components['schemas']['ArchivistRosterRole'];

/** Roster order: the job types, then the actors. */
const JOB_TYPES = [
  'reference-annotation',
  'highlight-annotation',
  'assessment-annotation',
  'comment-annotation',
  'tag-annotation',
  'generation',
] as const satisfies readonly (JobType & keyof Roster['workers'])[];
const ACTORS = ['gatherer', 'matcher'] as const satisfies readonly (keyof Roster['actors'])[];

/** The roster's dedup key — with one domain per KB, this pair IS the DID. */
const inferencePairKey = (role: RosterRole): string => `${role.provider} ${role.model}`;

export function deriveAgentRoster(config: Roster, domain: string | undefined): CollaboratorEntry[] {
  if (!domain) {
    throw new Error(
      "The knowledge base's committed .semiont/config declares no [site] domain, and agent DIDs are minted under it — the same domain /api/tokens/agent mints worker DIDs from (no topology fallback)",
    );
  }

  // Dedup by (provider, model) — with one domain per KB, that is the DID.
  const roster = new Map<string, { agent: Agent; servesJobTypes: JobType[] }>();
  const admit = (role: RosterRole | undefined, jobType?: JobType): void => {
    if (!role) return;
    const key = inferencePairKey(role);
    let entry = roster.get(key);
    if (!entry) {
      entry = {
        agent: softwareToAgent({ domain, provider: role.provider, model: role.model }),
        servesJobTypes: [],
      };
      roster.set(key, entry);
    }
    if (jobType) entry.servesJobTypes.push(jobType);
  };
  for (const jobType of JOB_TYPES) admit(config.workers[jobType], jobType);
  for (const actor of ACTORS) admit(config.actors[actor]);

  return [...roster.values()].map(({ agent, servesJobTypes }) =>
    servesJobTypes.length ? { agent, servesJobTypes } : { agent },
  );
}
