/**
 * The config → connection-string translation.
 *
 * This is the piece the retired CLI owned: `gateway-start.ts` built
 * `postgresql://user:pass@host:port/name` from the TOML it had already loaded,
 * and passed it to node. Nothing did it after the CLI was deleted, which is why
 * the container could not start at all — `migrate deploy` had no datasource url.
 */

import { describe, it, expect } from 'vitest';
import type { EnvironmentConfig } from '@semiont/core';
import { databaseUrlFrom } from '../../utils/database-url';

function configWith(database: Record<string, unknown>): EnvironmentConfig {
  return { services: { database } } as unknown as EnvironmentConfig;
}

const complete = {
  platform: 'external',
  type: 'postgres',
  host: 'semiont-postgres',
  port: 5432,
  name: 'semiont',
  user: 'postgres',
  password: 'localpass',
};

describe('databaseUrlFrom', () => {
  it('builds a connection string from the config block', () => {
    expect(databaseUrlFrom(configWith(complete)))
      .toBe('postgresql://postgres:localpass@semiont-postgres:5432/semiont');
  });

  // The CLI interpolated into a template string, so a password containing @ / :
  // or ? silently produced a malformed URL. new URL() encodes it.
  it('URL-encodes a password with URL-significant characters', () => {
    const url = databaseUrlFrom(configWith({ ...complete, password: 'p@ss/w:rd?x' }));
    expect(url).toContain('p%40ss%2Fw%3Ard%3Fx');
    // URL.password returns the encoded form, so decode to check the round trip —
    // this is what a driver's connection-string parser does.
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss/w:rd?x');
    // And the host/db survive intact rather than being eaten by the stray '/'.
    expect(new URL(url).hostname).toBe('semiont-postgres');
    expect(new URL(url).pathname).toBe('/semiont');
  });

  // sslmode=require is an RDS-era assumption. The launcher's postgres has no
  // TLS, so forcing it here would make every local stack fail to connect — and
  // the CLI's string deliberately carried no sslmode either.
  it('does not force sslmode', () => {
    expect(databaseUrlFrom(configWith(complete))).not.toContain('sslmode');
  });

  it.each(['host', 'port', 'name', 'user', 'password'])(
    'throws naming %s when it is missing',
    (key) => {
      const partial = { ...complete } as Record<string, unknown>;
      delete partial[key];
      expect(() => databaseUrlFrom(configWith(partial))).toThrow(new RegExp(key));
    },
  );

  it('throws when there is no database block at all', () => {
    expect(() => databaseUrlFrom({ services: {} } as unknown as EnvironmentConfig))
      .toThrow(/services\.database/);
  });

  // `database` and `username` are accepted aliases in DatabaseServiceConfig; the
  // launcher writes `name`/`user`, but a hand-written config may use either.
  it('accepts the database/username aliases', () => {
    const aliased = {
      platform: 'external', type: 'postgres',
      host: 'h', port: 5432, database: 'semiont', username: 'postgres', password: 'pw',
    };
    expect(databaseUrlFrom(configWith(aliased)))
      .toBe('postgresql://postgres:pw@h:5432/semiont');
  });
});
