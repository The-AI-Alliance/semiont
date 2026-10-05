/**
 * deriveAgentRoster mints DIDs from the KB's own domain — its committed
 * `[site] domain`, the SAME value `/api/tokens/agent` mints worker DIDs from —
 * never from service topology (`publicURL`) or any connection vantage.
 *
 * What it pins: a process that derives "the KB's domain" from its own vantage
 * point can disagree with another on the host of one logical agent — the
 * roster against the worker-stamped `generator`, which the attribution
 * loop compares. One value, one owner: the roster consumes the committed
 * domain; it derives nothing.
 */
import { describe, it, expect } from 'vitest';
import { deriveAgentRoster, type Roster } from '../archivist/agent-roster';

const ROSTER: Roster = {
  workers: { generation: { provider: 'anthropic', model: 'claude-haiku-4-5' } },
  actors: {},
};

describe('deriveAgentRoster — DID domain is the committed [site] domain (the mint), never topology', () => {
  it('mints did:web:<domain>', () => {
    const roster = deriveAgentRoster(ROSTER, 'kb.example');

    expect(roster.length).toBeGreaterThan(0);
    for (const entry of roster) {
      expect(entry.agent['@id']).toMatch(/^did:web:kb\.example:agents:/);
    }
  });

  it('throws loudly without a domain — no topology fallback', () => {
    expect(() => deriveAgentRoster(ROSTER, undefined)).toThrow(/\[site\] domain/);
  });

  it('carries a ported domain verbatim — byte-equal with the exchange mint', () => {
    const roster = deriveAgentRoster(ROSTER, 'localhost:4000');

    expect(roster[0]!.agent['@id']).toMatch(/^did:web:localhost:4000:agents:/);
  });
});

describe('deriveAgentRoster — roster order and dedup', () => {
  it('lists agents in order of first role: job types, then actors, each once', () => {
    const shared = { provider: 'anthropic', model: 'm-default' } as const;
    const roster = deriveAgentRoster(
      {
        workers: {
          'reference-annotation': shared,
          'highlight-annotation': shared,
          'assessment-annotation': shared,
          'comment-annotation': shared,
          'tag-annotation': shared,
          generation: { provider: 'anthropic', model: 'm-generation' },
        },
        actors: { gatherer: { provider: 'ollama', model: 'g-fallback' }, matcher: shared },
      },
      'kb.example',
    );

    expect(roster.map((e) => [e.agent.model, e.servesJobTypes ?? []])).toEqual([
      ['m-default', ['reference-annotation', 'highlight-annotation', 'assessment-annotation', 'comment-annotation', 'tag-annotation']],
      ['m-generation', ['generation']],
      ['g-fallback', []],
    ]);
  });
});
