import { beforeEach, describe, it, expect, vi } from 'vitest';

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

// The factory keeps the process's one connection. Each case reads the module
// afresh, so none is handed the connection another made.
beforeEach(() => {
  vi.resetModules();
});
const factory = () => import('../factory.js');

describe('@semiont/graph - factory', () => {
  it('makes no graph from the type a test alone uses', async () => {
    const { getGraphDatabase } = await factory();
    await expect(getGraphDatabase({ platform: { type: 'container' }, type: 'memory' })).rejects.toThrow(
      'Unsupported graph database type: memory',
    );
  });

  // By the time this config exists the config loader has resolved every
  // ${VAR}. A value that still contains `${…}` is the value, taken as given,
  // and a second pass over it would throw on a password like this one.
  it('hands a neo4j config to the driver exactly as given', async () => {
    const { getGraphDatabase } = await factory();
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

  it('answers the one connection it made to whoever asks again', async () => {
    const { getGraphDatabase } = await factory();
    const config = { platform: { type: 'container' as const }, type: 'neo4j' as const, uri: 'bolt://neo4j:7687', username: 'neo4j', password: 'p', database: 'neo4j' };
    expect(await getGraphDatabase(config)).toBe(await getGraphDatabase(config));
  });
});
