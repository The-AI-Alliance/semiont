/**
 * LimitsDiscovery — the Browser's discovery pool for per-`(provider, model)`
 * inference ceilings (INFERENCE-LIMITS-EXPOSURE P2).
 *
 * D1: the ONLY storage is in-memory — the pool's client instances, whose
 * `limits()` single-flights and caches success internally, and deliberately
 * clears its promise on failure so a briefly-down provider recovers on a
 * later request (absent → present, no restart needed).
 *
 * D3: enrichment must never fail or block the directory reply. Three guards
 * carry that, each pinned in `limits-discovery.test.ts`:
 *  - construction is guarded per pair — a throwing factory (e.g. an
 *    Anthropic section whose apiKey is left to worker-process env
 *    expansion) is a discovery failure, never a Browser startup failure;
 *  - every consult is raced against `LIMITS_ENRICH_BUDGET_MS`;
 *  - every failure path yields the entry WITHOUT `limits` — the same
 *    absence semantics `servesJobTypes` already has.
 */

import { createInferenceClient, type InferenceClient } from '@semiont/inference';
import type { Logger, components } from '@semiont/core';
import { deriveInferencePairs, inferencePairKey } from './agent-roster';
import type { InferenceConfig, MakeMeaningConfig } from './config';

type CollaboratorEntry = components['schemas']['CollaboratorEntry'];
type InferenceLimits = components['schemas']['InferenceLimits'];

/**
 * Per-request ceiling on ONE pair's discovery consult. The discovery calls
 * themselves carry no request timeout, so an unraced await would let one
 * hung provider wedge every `browse:agents` reply — exactly what D3
 * forbids. Small because the reply is interactive (the CollaborationPanel
 * reads it); nothing is wasted by losing the race, because the client's
 * single-flight promise keeps the discovery running and the NEXT request
 * attaches the then-cached result.
 */
export const LIMITS_ENRICH_BUDGET_MS = 1_500;

export interface LimitsDiscovery {
  /** The entries, each with `limits` attached where discovery answered within budget. */
  enrich(entries: CollaboratorEntry[]): Promise<CollaboratorEntry[]>;
}

export function createLimitsDiscovery(
  config: MakeMeaningConfig,
  logger: Logger,
  options?: {
    /** Test seam, plain argument: the client constructor. */
    clientFactory?: (config: InferenceConfig, logger?: Logger) => Pick<InferenceClient, 'limits'>;
    /** Test seam: the per-pair consult budget. */
    budgetMs?: number;
  },
): LimitsDiscovery {
  const clientFactory = options?.clientFactory ?? createInferenceClient;
  const budgetMs = options?.budgetMs ?? LIMITS_ENRICH_BUDGET_MS;

  // One guarded client per distinct roster pair, built once — the instance
  // reuse is what makes the clients' own caching the storage (D1).
  const clients = new Map<string, Pick<InferenceClient, 'limits'>>();
  for (const [pair, inference] of deriveInferencePairs(config)) {
    try {
      clients.set(pair, clientFactory(inference, logger));
    } catch (error) {
      logger.debug('Limits discovery: client construction failed — pair enriches as absent', {
        pair,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** One consult, bounded. Resolves undefined on any miss: over budget or rejected. */
  const consult = async (pair: string, client: Pick<InferenceClient, 'limits'>): Promise<InferenceLimits | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const discovery = client.limits();
      const raced = await Promise.race([
        discovery,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), budgetMs); }),
      ]);
      if (raced === undefined) {
        // Over budget. Detach so a late rejection is not an unhandled
        // rejection; the single-flight discovery itself keeps running.
        void discovery.catch(() => {});
        logger.debug('Limits discovery: consult exceeded budget — entry enriches as absent', { pair, budgetMs });
        return undefined;
      }
      // Spec-exact shape: attach only what the wire schema declares.
      return { contextTokens: raced.contextTokens, maxOutputTokens: raced.maxOutputTokens };
    } catch (error) {
      logger.debug('Limits discovery: consult failed — entry enriches as absent', {
        pair,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async enrich(entries) {
      // Entries are pair-unique by roster construction, so this is one
      // consult per pair per request; `consult` never rejects, so the
      // settled results are always fulfilled — mapped defensively anyway.
      const settled = await Promise.allSettled(entries.map(async (entry) => {
        // Only the Software variant of the Agent union carries
        // provider/model (the pair the pool keys by); Persons and
        // Organizations pass through untouched.
        const agent = entry.agent;
        if (agent['@type'] !== 'Software' || !agent.provider || !agent.model) return entry;
        const pair = inferencePairKey(agent.provider, agent.model);
        const client = clients.get(pair);
        if (!client) return entry;
        const limits = await consult(pair, client);
        return limits ? { ...entry, limits } : entry;
      }));
      return settled.map((s, i) => (s.status === 'fulfilled' ? s.value : entries[i]));
    },
  };
}
