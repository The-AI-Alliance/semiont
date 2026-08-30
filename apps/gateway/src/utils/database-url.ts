/**
 * Database URL Derivation
 *
 * The config → connection-string translation. This was the retired CLI's job:
 * `backend-start.ts` read the TOML it had already loaded and handed node a
 * `DATABASE_URL`. When the CLI went, so did the only thing that bridged the two
 * halves of the fact — the config knows the credentials, and the backend only
 * ever read a connection string from the environment.
 *
 * Kept separate from the server entry point on purpose: the container derives
 * this in its CMD, BEFORE `prisma migrate deploy` and before node, because
 * migrate runs as its own process and would never see a value assembled inside
 * the server. See apps/gateway/Dockerfile and src/cli/db-url.ts.
 */

import type { EnvironmentConfig } from '@semiont/core';

/**
 * Build a PostgreSQL connection string from `services.database`.
 *
 * Throws naming the missing key rather than returning a half-formed URL — a bad
 * connection string fails later and much less legibly than a missing one.
 */
export function databaseUrlFrom(config: EnvironmentConfig): string {
  const db = config.services?.database;
  if (!db) {
    throw new Error('services.database is required in environment config to derive DATABASE_URL');
  }

  // DatabaseServiceConfig accepts name/database and user/username as aliases.
  // The launcher writes name/user; hand-written configs use either.
  const name = db.name ?? db.database;
  const user = db.user ?? db.username;
  const missing = [
    ['host', db.host],
    ['port', db.port],
    ['name', name],
    ['user', user],
    ['password', db.password],
  ].filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `services.database is missing ${missing.join(', ')} — needed to derive DATABASE_URL`,
    );
  }

  // new URL() rather than string interpolation: it percent-encodes the
  // credentials. The CLI built this with a template string, so a password
  // containing @ / : or ? produced a malformed URL that failed at connect time
  // with nothing pointing at the password as the cause.
  const url = new URL('postgresql://placeholder');
  url.username = String(user);
  url.password = String(db.password);
  url.hostname = String(db.host);
  url.port = String(db.port);
  url.pathname = `/${name}`;

  // Deliberately NO sslmode. The launcher's postgres:15.18-alpine serves no TLS,
  // so forcing sslmode=require would break every local stack; the CLI's string
  // carried none either. A deployment that needs TLS supplies DATABASE_URL
  // directly, which wins over this derivation.
  return url.toString();
}
