import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGraphDatabase, getGraphDatabase, closeGraphDatabase } from '../factory.js';

// What the Neo4j driver is handed: the only place a credential's final value
// is visible.
const handed = vi.hoisted(() => ({ uri: '', username: '', password: '' }));
vi.mock('neo4j-driver', () => {
  const session = () => ({ run: async () => ({ records: [] }), close: async () => {} });
  const auth = {
    basic: (username: string, password: string) => {
      handed.username = username;
      handed.password = password;
      return { scheme: 'basic' };
    },
  };
  const driver = (uri: string) => {
    handed.uri = uri;
    return { session, close: async () => {} };
  };
  return { default: { driver, auth }, driver, auth };
});

describe('@semiont/graph - factory', () => {
  describe('createGraphDatabase', () => {
    it('should create a memory graph database', () => {
      const db = createGraphDatabase({ type: 'memory' });

      expect(db).toBeDefined();
      expect(db).toHaveProperty('connect');
      expect(db).toHaveProperty('disconnect');
      expect(db).toHaveProperty('isConnected');
    });

    it('should throw error for unsupported graph types', () => {
      expect(() => {
        // @ts-expect-error - testing invalid type
        createGraphDatabase({ type: 'invalid-type' });
      }).toThrow('Unsupported graph database type');
    });
  });

  describe('getGraphDatabase', () => {
    afterEach(() => closeGraphDatabase());

    // By the time this config exists the config loader has resolved every
    // ${VAR}. A value that still contains `${…}` is the value, taken as given,
    // and a second pass over it would throw on a password like this one.
    it('hands a neo4j config to the driver exactly as given', async () => {
      await getGraphDatabase({
        platform: { type: 'container' },
        type: 'neo4j',
        uri: 'bolt://neo4j:7687',
        username: 'neo4j',
        password: 'ab${cd}',
        database: 'neo4j',
      });
      expect(handed).toEqual({ uri: 'bolt://neo4j:7687', username: 'neo4j', password: 'ab${cd}' });
    });
  });
});
