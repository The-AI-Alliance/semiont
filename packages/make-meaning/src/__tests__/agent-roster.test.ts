/**
 * deriveAgentRoster mints DIDs from the KB's canonical identity —
 * `site.domain`, the SAME value `/api/tokens/agent` mints worker DIDs from —
 * never from service topology (`publicURL`) or any connection vantage.
 *
 * Pins Lane B of .plans/bugs/agent-did-host-skew.md (Option 1): three
 * processes derived "the KB's domain" from three vantage points, and spec
 * 18's attribution loop caught the roster and the worker-stamped `generator`
 * disagreeing on the host of one logical agent. One value, one owner: the
 * roster consumes `site.domain`; it derives nothing.
 */
import { describe, it, expect } from 'vitest';
import { deriveAgentRoster } from '../agent-roster';
import type { MakeMeaningConfig } from '../config';

const WORKERS = { default: { type: 'anthropic' as const, model: 'claude-haiku-4-5' } };

describe('deriveAgentRoster — DID domain is site.domain (the mint), never topology', () => {
  it('mints did:web:<site.domain> — the host-skew pin (topology no longer exists to mint from)', () => {
    // Pre-fix, the roster minted from services.backend.publicURL's hostname
    // (→ did:web:localhost while identity said kb.example). That field is
    // deleted from MakeMeaningConfig — the skew is now unrepresentable, and
    // this pins the one remaining source.
    const config: MakeMeaningConfig = {
      services: {},
      gather: { settleTimeoutMs: 15_000 },
      site: { domain: 'kb.example' }, // the KB's identity — the exchange's mint value
      workers: WORKERS,
    };

    const roster = deriveAgentRoster(config);

    expect(roster.length).toBeGreaterThan(0);
    for (const entry of roster) {
      expect(entry.agent['@id']).toMatch(/^did:web:kb\.example:agents:/);
    }
  });

  it('throws loudly without site.domain — no topology fallback', () => {
    const config: MakeMeaningConfig = {
      services: {},
      gather: { settleTimeoutMs: 15_000 },
      workers: WORKERS,
    };

    expect(() => deriveAgentRoster(config)).toThrow(/site\.domain/);
  });

  it('carries a ported site.domain verbatim — byte-equal with the exchange mint', () => {
    const config: MakeMeaningConfig = {
      services: {},
      gather: { settleTimeoutMs: 15_000 },
      site: { domain: 'localhost:4000' },
      workers: WORKERS,
    };

    const roster = deriveAgentRoster(config);

    // agentToDid gets the identical string the /api/tokens/agent exchange
    // passes it — spec 18's attribution equality is byte equality of DIDs.
    expect(roster[0]!.agent['@id']).toMatch(/^did:web:localhost:4000:agents:/);
  });
});
