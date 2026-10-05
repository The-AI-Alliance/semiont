/**
 * deriveAgentRoster mints DIDs from the KB's own domain — its committed
 * `[site] domain`, the SAME value `/api/tokens/agent` mints worker DIDs from —
 * never from service topology (`publicURL`) or any connection vantage.
 *
 * What it pins: a process that derives "the KB's domain" from its own vantage
 * point can disagree with another on the host of one logical agent — the
 * roster against the worker-stamped `generator`, which spec 18's attribution
 * loop compares. One value, one owner: the roster consumes the committed
 * domain; it derives nothing.
 */
import { describe, it, expect } from 'vitest';
import { loadTomlConfig } from '@semiont/core';
import { deriveAgentRoster } from '../agent-roster';
import { rosterConfigFrom, type MakeMeaningConfig } from '../config';

const WORKERS = { default: { type: 'anthropic' as const, model: 'claude-haiku-4-5' } };

describe('deriveAgentRoster — DID domain is the committed [site] domain (the mint), never topology', () => {
  it('mints did:web:<domain> — the host-skew pin (the config holds no topology to mint from)', () => {
    // MakeMeaningConfig carries no gateway publicURL, so a roster minted from
    // its hostname (→ did:web:localhost while identity says kb.example) is
    // unrepresentable; this pins the one source.
    const config: MakeMeaningConfig = {
      services: { vectors: { type: 'memory' }, embedding: { type: 'ollama', model: 'nomic-embed-text' } },
      gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 },
      workers: WORKERS,
    };

    const roster = deriveAgentRoster(config, 'kb.example'); // the KB's identity — the exchange's mint value

    expect(roster.length).toBeGreaterThan(0);
    for (const entry of roster) {
      expect(entry.agent['@id']).toMatch(/^did:web:kb\.example:agents:/);
    }
  });

  it('throws loudly without a domain — no topology fallback', () => {
    const config: MakeMeaningConfig = {
      services: { vectors: { type: 'memory' }, embedding: { type: 'ollama', model: 'nomic-embed-text' } },
      gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 },
      workers: WORKERS,
    };

    expect(() => deriveAgentRoster(config, undefined)).toThrow(/\[site\] domain/);
  });

  it('carries a ported domain verbatim — byte-equal with the exchange mint', () => {
    const config: MakeMeaningConfig = {
      services: { vectors: { type: 'memory' }, embedding: { type: 'ollama', model: 'nomic-embed-text' } },
      gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 },
      workers: WORKERS,
    };

    const roster = deriveAgentRoster(config, 'localhost:4000');

    // agentToDid gets the identical string the /api/tokens/agent exchange
    // passes it — spec 18's attribution equality is byte equality of DIDs.
    expect(roster[0]!.agent['@id']).toMatch(/^did:web:localhost:4000:agents:/);
  });
});

// The archivist lists the roster and holds no inference credential: the
// worker and the librarian are the only two images that get inference
// secrets. It derives the roster from the keyless role maps, and the result
// is the roster the credentialed config derives: the same agents, the same
// job types, the same inheritance.
describe('the archivist derives the roster without [inference]', () => {
  const TOML = `
[environments.local.identity]
type = "keycloak"
issuer = "http://localhost:8080/realms/semiont"
subjectClaim = "sub"

[environments.local.inference.anthropic]
platform = "external"
apiKey = "\${ARCHIVIST_NEVER_SEES_THIS}"

[environments.local.workers.default.inference]
type = "anthropic"
model = "m-default"

[environments.local.workers.generation.inference]
type = "anthropic"
model = "m-generation"

[environments.local.make-meaning.default.inference]
type = "ollama"
model = "g-fallback"

[environments.local.actors.matcher.inference]
type = "anthropic"
model = "m-default"
`;
  const reader = { readIfExists: (p: string) => (p.endsWith('/.semiontconfig') ? TOML : null) };

  it('lists every role the credentialed config serves, with its job types', () => {
    const archivist = loadTomlConfig(null, 'local', '/home/u/.semiontconfig', reader, {}, 'archivist');
    const credentialed: MakeMeaningConfig = {
      services: { vectors: { type: 'memory' }, embedding: { type: 'ollama', model: 'nomic-embed-text' } },
      gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 },
      workers: {
        default: { type: 'anthropic', model: 'm-default', apiKey: 'k' },
        generation: { type: 'anthropic', model: 'm-generation', apiKey: 'k' },
      },
      actors: {
        gatherer: { type: 'ollama', model: 'g-fallback' },
        matcher: { type: 'anthropic', model: 'm-default', apiKey: 'k' },
      },
    };

    const roster = deriveAgentRoster(rosterConfigFrom(archivist), 'kb.example');

    expect(roster).toEqual(deriveAgentRoster(credentialed, 'kb.example'));
    expect(roster.map((e) => [e.agent.model, e.servesJobTypes ?? []])).toEqual([
      ['m-default', ['reference-annotation', 'highlight-annotation', 'assessment-annotation', 'comment-annotation', 'tag-annotation']],
      ['m-generation', ['generation']],
      ['g-fallback', []],
    ]);
  });
});
