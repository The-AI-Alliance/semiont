import { describe, it, expect } from 'vitest';
import { userToDid, userToAgent, didToAgent, agentToDid, softwareToAgent } from '../did-utils';

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

    it('falls back to a Person Agent for malformed DIDs', () => {
      const agent = didToAgent('invalid-did-format');
      expect(agent['@type']).toBe('Person');
      expect(agent['@id']).toBe('invalid-did-format');
      expect(agent.name).toBe('invalid-did-format');
    });

    it('returns an unknown placeholder for empty/null DIDs', () => {
      expect(didToAgent('')).toEqual({
        '@type': 'Person',
        '@id': 'unknown',
        name: 'unknown',
      });
      expect(didToAgent(null)).toEqual({
        '@type': 'Person',
        '@id': 'unknown',
        name: 'unknown',
      });
      expect(didToAgent(undefined)).toEqual({
        '@type': 'Person',
        '@id': 'unknown',
        name: 'unknown',
      });
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
});
