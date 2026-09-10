import { describe, it, expect } from 'vitest';
import { userToDid, userToAgent, didToAgent, agentToDid, softwareToAgent, kbDid } from '../did-utils';

import { validators } from '../openapi';

/**
 * One legacy `userId` makes an entire reply unemittable.
 *
 * Observed 2026-09-09: nine resources in a live KB, eight carrying
 * `did:web:localhost:users:pingel` and one carrying a raw CUID
 * (`cmmvann9g00003007ofcst9c2`) from events dated 2026-03-26, before the DID
 * convention. `@id` is `format: "uri"` in every Agent branch, so the CUID failed
 * all three and `browse:resources-result` was rejected whole — **all nine
 * resources**, permanently and deterministically, with the caller seeing only a
 * reply that never arrived.
 *
 * The event log is append-only and those events are correct history, so the fix
 * is necessarily on the read side.
 */
describe('didToAgent never emits a non-URI @id (2026-09-09)', () => {
  const CUID = 'cmmvann9g00003007ofcst9c2';

  it.each([
    ['a user DID', 'did:web:localhost:users:pingel'],
    ['an agent DID', 'did:web:localhost:agents:ollama:llama3'],
    ['the measured legacy CUID', CUID],
    ['an unrecognized non-URI string', 'invalid-did-format'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a bare scheme with no path', 'did:'],
  ])('validates against the Agent schema: %s', (_label, input) => {
    // THE assertion whose absence let this ship. The unit tests checked the SHAPE
    // `didToAgent` returns and never checked it against the SCHEMA that governs
    // it — a hand-written expectation standing in for the spec, which is the
    // mirror this codebase refuses elsewhere. Ajv is the authority here, not a
    // second table of what we think a URI looks like.
    const agent = didToAgent(input as string | null | undefined);
    expect(validators.Agent(agent), JSON.stringify(agent)).toBe(true);
  });

  it('keeps a valid DID as @id — the eight good resources are untouched', () => {
    expect(didToAgent('did:web:localhost:users:pingel')['@id']).toBe('did:web:localhost:users:pingel');
    expect(didToAgent('did:web:localhost:agents:ollama:llama3')['@id']).toBe('did:web:localhost:agents:ollama:llama3');
  });

  it('surfaces the CUID as `name`, so nothing is silently lost', () => {
    // Dropping `@id` must not erase the identity. A reader still sees which
    // actor this was, which is what makes the tolerance honest rather than a
    // quiet discard.
    const agent = didToAgent(CUID);
    expect(agent).not.toHaveProperty('@id');
    expect(agent.name).toBe(CUID);
  });
});

describe('@semiont/core - did-utils', () => {
  describe('userToDid', () => {
    it('should convert user to DID:WEB format using email', () => {
      const did = userToDid({ email: 'alice@example.com', domain: 'example.com' });
      expect(did).toBe('did:web:example.com:users:alice%40example.com');
    });

    it('should handle different domains', () => {
      expect(userToDid({ email: 'bob@semiont.app', domain: 'api.semiont.app' }))
        .toBe('did:web:api.semiont.app:users:bob%40semiont.app');
      expect(userToDid({ email: 'carol@example.com', domain: 'localhost:3000' }))
        .toBe('did:web:localhost:3000:users:carol%40example.com');
    });

    it('should URI-encode the email', () => {
      const did = userToDid({ email: 'user+tag@example.org', domain: 'example.org' });
      expect(did).toBe('did:web:example.org:users:user%2Btag%40example.org');
    });
  });

  describe('agentToDid', () => {
    it('builds a DID:WEB identifier for a software peer', () => {
      const did = agentToDid({ domain: 'example.com', provider: 'ollama', model: 'gemma2:27b' });
      expect(did).toBe('did:web:example.com:agents:ollama:gemma2%3A27b');
    });

    it('encodes slashes and colons in the model identifier', () => {
      const did = agentToDid({ domain: 'example.com', provider: 'ollama', model: 'library/llama3:70b' });
      expect(did).toBe('did:web:example.com:agents:ollama:library%2Fllama3%3A70b');
    });

    it('encodes the provider too', () => {
      const did = agentToDid({ domain: 'example.com', provider: 'an/thropic', model: 'claude' });
      expect(did).toBe('did:web:example.com:agents:an%2Fthropic:claude');
    });
  });

  describe('userToAgent', () => {
    it('returns a typed Person Agent', () => {
      const agent = userToAgent({
        id: 'alice123',
        domain: 'example.com',
        name: 'Alice Smith',
        email: 'alice@example.com',
      });

      expect(agent).toEqual({
        '@type': 'Person',
        '@id': 'did:web:example.com:users:alice%40example.com',
        name: 'Alice Smith',
      });
    });

    it('falls back to email when name is null', () => {
      const agent = userToAgent({
        id: 'bob456',
        domain: 'example.com',
        name: null,
        email: 'bob@example.com',
      });

      expect(agent.name).toBe('bob@example.com');
      expect(agent['@type']).toBe('Person');
    });

    it('falls back to email when name is empty string', () => {
      const agent = userToAgent({
        id: 'carol789',
        domain: 'example.com',
        name: '',
        email: 'carol@example.com',
      });

      expect(agent.name).toBe('carol@example.com');
    });
  });

  describe('softwareToAgent', () => {
    it('returns a typed Software Agent', () => {
      const agent = softwareToAgent({
        domain: 'example.com',
        provider: 'ollama',
        model: 'gemma2:27b',
      });

      expect(agent).toEqual({
        '@type': 'Software',
        '@id': 'did:web:example.com:agents:ollama:gemma2%3A27b',
        name: 'ollama gemma2:27b',
        provider: 'ollama',
        model: 'gemma2:27b',
      });
    });

    it('preserves parameters when supplied', () => {
      const agent = softwareToAgent({
        domain: 'example.com',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        parameters: { temperature: 0.2, maxTokens: 4096 },
      });

      expect(agent['@type']).toBe('Software');
      expect((agent as { parameters?: Record<string, unknown> }).parameters)
        .toEqual({ temperature: 0.2, maxTokens: 4096 });
    });

    it('omits parameters when not supplied', () => {
      const agent = softwareToAgent({
        domain: 'example.com',
        provider: 'ollama',
        model: 'gemma2:27b',
      });
      expect((agent as { parameters?: unknown }).parameters).toBeUndefined();
    });
  });

  describe('didToAgent', () => {
    it('parses a Person DID', () => {
      const agent = didToAgent('did:web:example.com:users:alice%40example.com');
      expect(agent).toEqual({
        '@type': 'Person',
        '@id': 'did:web:example.com:users:alice%40example.com',
        name: 'alice@example.com',
      });
    });

    it('parses a Person DID with a port in the host', () => {
      const agent = didToAgent('did:web:subdomain.example.com:8080:users:carol%40example.com');
      expect(agent).toEqual({
        '@type': 'Person',
        '@id': 'did:web:subdomain.example.com:8080:users:carol%40example.com',
        name: 'carol@example.com',
      });
    });

    it('parses a Software DID', () => {
      const agent = didToAgent('did:web:example.com:agents:ollama:gemma2%3A27b');
      expect(agent).toEqual({
        '@type': 'Software',
        '@id': 'did:web:example.com:agents:ollama:gemma2%3A27b',
        name: 'ollama gemma2:27b',
        provider: 'ollama',
        model: 'gemma2:27b',
      });
    });

    it('parses a Software DID with a port in the host', () => {
      const agent = didToAgent('did:web:example.com:8080:agents:anthropic:claude-3-5-sonnet');
      expect(agent).toEqual({
        '@type': 'Software',
        '@id': 'did:web:example.com:8080:agents:anthropic:claude-3-5-sonnet',
        name: 'anthropic claude-3-5-sonnet',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
      });
    });

    it('parses a Software DID with slashes in the model', () => {
      const agent = didToAgent('did:web:example.com:agents:ollama:library%2Fllama3%3A70b');
      expect(agent).toEqual({
        '@type': 'Software',
        '@id': 'did:web:example.com:agents:ollama:library%2Fllama3%3A70b',
        name: 'ollama library/llama3:70b',
        provider: 'ollama',
        model: 'library/llama3:70b',
      });
    });

    it('falls back to a Person Agent for malformed DIDs, WITHOUT an @id', () => {
      // Changed 2026-09-09. This test used to assert `@id === 'invalid-did-format'`
      // and passed — pinning a value the wire rejects. `@id` is `format: "uri"` in
      // all three Agent branches, so a non-URI fails every branch and takes the
      // whole `browse:resources-result` reply down with it.
      const agent = didToAgent('invalid-did-format');
      expect(agent['@type']).toBe('Person');
      expect(agent).not.toHaveProperty('@id');
      expect(agent.name).toBe('invalid-did-format');
    });

    it('returns a named-but-unidentified Person for empty/null DIDs', () => {
      // The `'unknown'` fabrication is gone. `@id` is NOT required by any branch,
      // so omitting it validates — which makes the old placeholder strictly worse
      // than absence: it invented a value AND broke the wire.
      expect(didToAgent('')).toEqual({ '@type': 'Person', name: 'unknown' });
      expect(didToAgent(null)).toEqual({ '@type': 'Person', name: 'unknown' });
      expect(didToAgent(undefined)).toEqual({ '@type': 'Person', name: 'unknown' });
    });

    it('preserves the original DID as @id', () => {
      const did = 'did:web:example.com:users:test-user-123';
      expect(didToAgent(did)['@id']).toBe(did);
    });
  });

  describe('round-trip conversions', () => {
    it('round-trips a Person', () => {
      const user = {
        id: 'alice123',
        domain: 'example.com',
        name: 'Alice Smith',
        email: 'alice@example.com',
      };

      const did = userToDid(user);
      const agentFromDid = didToAgent(did);
      const agentFromUser = userToAgent(user);

      expect(agentFromDid['@id']).toBe(agentFromUser['@id']);
      expect(agentFromDid['@type']).toBe(agentFromUser['@type']);
      expect(agentFromDid.name).toBe('alice@example.com');
    });

    it('round-trips a Software peer', () => {
      const software = { domain: 'example.com', provider: 'ollama', model: 'gemma2:27b' };

      const did = agentToDid(software);
      const agentFromDid = didToAgent(did);
      const agentFromSoftware = softwareToAgent(software);

      expect(agentFromDid['@id']).toBe(agentFromSoftware['@id']);
      expect(agentFromDid['@type']).toBe('Software');
      expect((agentFromDid as { provider?: string }).provider).toBe('ollama');
      expect((agentFromDid as { model?: string }).model).toBe('gemma2:27b');
    });
  });

  /**
   * The KB's own identity — not a person's, not an agent's. The launcher
   * mints the identical string in Go (`kbconfig.go` didWeb():
   * `"did:web:" + Domain`), and the two must agree byte-for-byte or the
   * Browser's identity join silently never matches
   * (.plans/KB-IDENTITY-VS-ADDRESS.md).
   */
  describe('kbDid', () => {
    it('is did:web: + the declared domain, VERBATIM — colon-path form untouched', () => {
      expect(kbDid('the-ai-alliance.github.io:semiont-caselaw-kb'))
        .toBe('did:web:the-ai-alliance.github.io:semiont-caselaw-kb');
    });

    it('does NOT url-encode the domain (unlike the agent/user path segments)', () => {
      // Colons here are did:web path separators, not data — encoding them
      // would produce a string the launcher never mints.
      const did = kbDid('example.org:kb');
      expect(did).not.toContain('%3A');
      expect(did).toBe('did:web:example.org:kb');
    });

    it("prefixes its own agents' dids — one KB identity, its agents beneath it", () => {
      const domain = 'the-ai-alliance.github.io:semiont-caselaw-kb';
      const agent = agentToDid({ domain, provider: 'anthropic', model: 'claude-haiku-4-5' });
      expect(agent.startsWith(`${kbDid(domain)}:agents:`)).toBe(true);
    });
  });
});
