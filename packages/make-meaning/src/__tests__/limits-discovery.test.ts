/**
 * LimitsDiscovery — the Browser's per-(provider, model) discovery pool
 * (INFERENCE-LIMITS-EXPOSURE P2).
 *
 * The D3 contract under test from every failure direction: the directory
 * reply never fails and never blocks on a provider — a rejecting discovery,
 * a throwing client factory, and a HANGING discovery all degrade to an
 * entry without `limits`, while healthy pairs still enrich. Recovery is
 * pinned too: a failed pair is re-consulted on a later request (the real
 * clients deliberately clear their single-flight promise on rejection —
 * anthropic.ts "never cache a failed discovery"; the pool must not defeat
 * that by memoizing failures itself).
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus, agentToDid, type Logger, type components } from '@semiont/core';
import { firstValueFrom, race, timer, map, take } from 'rxjs';
import { createLimitsDiscovery } from '../limits-discovery';
import { deriveAgentRoster } from '../agent-roster';
import { Browser } from '../browser';
import type { InferenceConfig, MakeMeaningConfig } from '../config';

type InferenceLimits = components['schemas']['InferenceLimits'];

const mockLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => mockLogger,
};

// Two distinct pairs: one worker-derived (serves job types), one actor-only.
const CONFIG: MakeMeaningConfig = {
  services: {},
  gather: { settleTimeoutMs: 15_000 },
  site: { domain: 'kb.example' },
  workers: { default: { type: 'anthropic', model: 'model-a', apiKey: 'k' } },
  actors: { matcher: { type: 'ollama', model: 'model-b' } },
};

const LIMITS_A: InferenceLimits = { contextTokens: 200_000, maxOutputTokens: 64_000 };
const LIMITS_B: InferenceLimits = { contextTokens: 8_192, maxOutputTokens: 8_192 };

/**
 * A factory whose per-pair behavior the test scripts. A pair with no
 * behavior THROWS at construction — the missing-apiKey shape of the real
 * factory (factory.ts:21).
 */
function scriptedFactory(behaviors: Record<string, () => Promise<InferenceLimits>>) {
  const constructed: string[] = [];
  const factory = (cfg: InferenceConfig) => {
    const pair = `${cfg.type} ${cfg.model}`;
    const behave = behaviors[pair];
    if (!behave) throw new Error(`no client constructible for ${pair}`);
    constructed.push(pair);
    return { limits: () => behave() };
  };
  return { factory, constructed };
}

const entryFor = (entries: ReturnType<typeof deriveAgentRoster>, model: string) =>
  entries.find((e) => e.agent.model === model);

describe('LimitsDiscovery (INFERENCE-LIMITS-EXPOSURE P2)', () => {
  it('attaches discovered ceilings per (provider, model) — actor-only entries included', async () => {
    const { factory } = scriptedFactory({
      'anthropic model-a': () => Promise.resolve(LIMITS_A),
      'ollama model-b': () => Promise.resolve(LIMITS_B),
    });
    const discovery = createLimitsDiscovery(CONFIG, mockLogger, { clientFactory: factory });

    const enriched = await discovery.enrich(deriveAgentRoster(CONFIG));

    expect(entryFor(enriched, 'model-a')?.limits).toEqual(LIMITS_A);
    // The actor-only pair (no servesJobTypes) is a software collaborator
    // like any other — it enriches too (RED iii).
    const actorOnly = entryFor(enriched, 'model-b');
    expect(actorOnly?.limits).toEqual(LIMITS_B);
    expect(actorOnly).not.toHaveProperty('servesJobTypes');
  });

  it('a rejecting discovery yields the entry without limits; healthy pairs still enrich (D3)', async () => {
    const { factory } = scriptedFactory({
      'anthropic model-a': () => Promise.resolve(LIMITS_A),
      'ollama model-b': () => Promise.reject(new Error('provider briefly down')),
    });
    const discovery = createLimitsDiscovery(CONFIG, mockLogger, { clientFactory: factory });

    const enriched = await discovery.enrich(deriveAgentRoster(CONFIG));

    expect(entryFor(enriched, 'model-a')?.limits).toEqual(LIMITS_A);
    expect(entryFor(enriched, 'model-b')).not.toHaveProperty('limits');
    expect(enriched).toHaveLength(2);
  });

  it('reuses one client per pair across requests, and a failed pair recovers on a later request', async () => {
    let down = true;
    const { factory, constructed } = scriptedFactory({
      'anthropic model-a': () => Promise.resolve(LIMITS_A),
      'ollama model-b': () => (down ? Promise.reject(new Error('down')) : Promise.resolve(LIMITS_B)),
    });
    const discovery = createLimitsDiscovery(CONFIG, mockLogger, { clientFactory: factory });
    const roster = deriveAgentRoster(CONFIG);

    const first = await discovery.enrich(roster);
    expect(entryFor(first, 'model-b')).not.toHaveProperty('limits');

    down = false;
    const second = await discovery.enrich(roster);
    // Recovery: absent → present, with NO new client construction — the
    // instances are the pool; per-call caching is the real clients' own
    // (single-flight, cleared on failure), which the pool must not defeat.
    expect(entryFor(second, 'model-b')?.limits).toEqual(LIMITS_B);
    expect(constructed).toEqual(['anthropic model-a', 'ollama model-b']);
  });

  it('a throwing client factory is a discovery failure, not a construction failure (D3)', async () => {
    // Only model-a is constructible; model-b's factory throw is the real
    // factory's missing-apiKey shape.
    const { factory } = scriptedFactory({
      'anthropic model-a': () => Promise.resolve(LIMITS_A),
    });

    const discovery = createLimitsDiscovery(CONFIG, mockLogger, { clientFactory: factory });
    const enriched = await discovery.enrich(deriveAgentRoster(CONFIG));

    expect(entryFor(enriched, 'model-a')?.limits).toEqual(LIMITS_A);
    expect(entryFor(enriched, 'model-b')).not.toHaveProperty('limits');
  });

  it('a hanging discovery does not block the reply — bounded by the enrichment budget (D3)', async () => {
    const { factory } = scriptedFactory({
      'anthropic model-a': () => Promise.resolve(LIMITS_A),
      'ollama model-b': () => new Promise<InferenceLimits>(() => { /* never settles */ }),
    });
    const discovery = createLimitsDiscovery(CONFIG, mockLogger, { clientFactory: factory, budgetMs: 40 });

    const enriched = await discovery.enrich(deriveAgentRoster(CONFIG));

    expect(entryFor(enriched, 'model-a')?.limits).toEqual(LIMITS_A);
    expect(entryFor(enriched, 'model-b')).not.toHaveProperty('limits');
  });

  it('end to end: the Browser serves a roster enriched by a real LimitsDiscovery', async () => {
    const { factory } = scriptedFactory({
      'anthropic model-a': () => Promise.resolve(LIMITS_A),
      'ollama model-b': () => Promise.resolve(LIMITS_B),
    });
    const bus = new EventBus();
    const browser = new Browser(
      { getAll: async () => [] } as never,
      { graph: {}, views: {} } as never,
      bus,
      { root: '/tmp' } as never,
      CONFIG,
      createLimitsDiscovery(CONFIG, mockLogger, { clientFactory: factory }),
      mockLogger,
    );
    await browser.initialize();
    try {
      const reply = firstValueFrom(
        race(
          bus.get('browse:agents-result').pipe(map((e) => e)),
          bus.get('browse:agents-failed').pipe(
            map((e): never => { throw new Error(`agents failed: ${e.message}`); }),
          ),
          timer(500).pipe(map((): never => { throw new Error('no reply'); })),
        ).pipe(take(1)),
      );
      bus.get('browse:agents-requested').next({ correlationId: 'cid-e2e' });
      const r = await reply;

      const did = agentToDid({ domain: 'kb.example', provider: 'ollama', model: 'model-b' });
      const actorEntry = r.response.agents.find((a) => a.agent['@id'] === did);
      expect(actorEntry?.limits).toEqual(LIMITS_B);
      expect(r.response.agents.every((a) => a.limits !== undefined)).toBe(true);
    } finally {
      await browser.stop();
      bus.destroy();
    }
  });
});
