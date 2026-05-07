import { describe, it, expect } from 'vitest';
import { userToDid, userToAgent, didToAgent } from '../did-utils';

describe('@semiont/core - did-utils', () => {
  describe('userToDid', () => {
    it('should convert user to DID:WEB format using email', () => {
      const user = {
        email: 'alice@example.com',
        domain: 'example.com',
      };

      const did = userToDid(user);

      expect(did).toBe('did:web:example.com:users:alice%40example.com');
    });

    it('should handle different domains', () => {
      const user1 = {
        email: 'bob@semiont.app',
        domain: 'api.semiont.app',
      };
      const user2 = {
        email: 'carol@example.com',
        domain: 'localhost:3000',
      };

      expect(userToDid(user1)).toBe('did:web:api.semiont.app:users:bob%40semiont.app');
      expect(userToDid(user2)).toBe('did:web:localhost:3000:users:carol%40example.com');
    });

    it('should URI-encode the email', () => {
      const user = {
        email: 'user+tag@example.org',
        domain: 'example.org',
      };

      const did = userToDid(user);

      expect(did).toBe('did:web:example.org:users:user%2Btag%40example.org');
    });
  });

  describe('userToAgent', () => {
    it('should convert user with name to W3C Agent', () => {
      const user = {
        id: 'alice123',
        domain: 'example.com',
        name: 'Alice Smith',
        email: 'alice@example.com',
      };

      const agent = userToAgent(user);

      expect(agent).toEqual({
        type: 'Person',
        id: 'did:web:example.com:users:alice%40example.com',
        name: 'Alice Smith',
      });
    });

    it('should use email as name when name is null', () => {
      const user = {
        id: 'bob456',
        domain: 'example.com',
        name: null,
        email: 'bob@example.com',
      };

      const agent = userToAgent(user);

      expect(agent).toEqual({
        type: 'Person',
        id: 'did:web:example.com:users:bob%40example.com',
        name: 'bob@example.com',
      });
    });

    it('should use email as name when name is empty string', () => {
      const user = {
        id: 'carol789',
        domain: 'example.com',
        name: '',
        email: 'carol@example.com',
      };

      const agent = userToAgent(user);

      expect(agent.name).toBe('carol@example.com');
    });

    it('should always set type to Person', () => {
      const user = {
        id: 'test',
        domain: 'example.com',
        name: 'Test User',
        email: 'test@example.com',
      };

      const agent = userToAgent(user);

      expect(agent.type).toBe('Person');
    });
  });

  describe('didToAgent', () => {
    it('should convert DID to W3C Agent decoding email', () => {
      const did = 'did:web:example.com:users:alice%40example.com';

      const agent = didToAgent(did);

      expect(agent).toEqual({
        type: 'Person',
        id: 'did:web:example.com:users:alice%40example.com',
        name: 'alice@example.com',
      });
    });

    it('should decode URI-encoded email from last part of DID', () => {
      const did = 'did:web:api.semiont.app:users:bob%40semiont.app';

      const agent = didToAgent(did);

      expect(agent.name).toBe('bob@semiont.app');
    });

    it('should handle DIDs with complex domains', () => {
      const did = 'did:web:subdomain.example.com:8080:users:carol%40example.com';

      const agent = didToAgent(did);

      expect(agent).toEqual({
        type: 'Person',
        id: 'did:web:subdomain.example.com:8080:users:carol%40example.com',
        name: 'carol@example.com',
      });
    });

    it('should handle malformed DIDs gracefully', () => {
      const did = 'invalid-did-format';

      const agent = didToAgent(did);

      expect(agent.type).toBe('Person');
      expect(agent.id).toBe('invalid-did-format');
      expect(agent.name).toBe('invalid-did-format'); // Whole string since no ':' delimiter
    });

    it('should handle empty DID', () => {
      const did = '';

      const agent = didToAgent(did);

      expect(agent).toEqual({
        type: 'Person',
        id: 'unknown',
        name: 'unknown',
      });
    });

    it('should preserve original DID as id', () => {
      const did = 'did:web:example.com:users:test-user-123';

      const agent = didToAgent(did);

      expect(agent.id).toBe(did);
    });
  });

  describe('round-trip conversions', () => {
    it('should maintain DID consistency when converting user -> DID -> Agent', () => {
      const user = {
        id: 'alice123',
        domain: 'example.com',
        name: 'Alice Smith',
        email: 'alice@example.com',
      };

      const did = userToDid(user);
      const agentFromDid = didToAgent(did);
      const agentFromUser = userToAgent(user);

      // Both agents should have the same DID and decoded name
      expect(agentFromDid.id).toBe(agentFromUser.id);
      expect(agentFromDid.type).toBe(agentFromUser.type);
      expect(agentFromDid.name).toBe('alice@example.com');
    });
  });
});
