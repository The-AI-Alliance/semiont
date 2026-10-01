/**
 * How a client holds a session is one table, specs/src/session/cases.json, run
 * here through the SDK's own schedule and token reader. Every SDK that holds a
 * session runs the same table: a mirror across implementations, gated by one
 * table rather than generated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseJwtExpiry, refreshDelayMs } from '../storage';

interface ScheduleCase {
  why: string;
  claims?: { iat?: number; exp?: number };
  token?: string;
  /** Seconds, like the claims. */
  now: number;
  /** Seconds, or null when nothing is scheduled. */
  delay: number | null;
}

interface ExpiryCase {
  why: string;
  token: string;
  exp: number | null;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../specs/src/session/cases.json');
const { refreshSchedule, tokenExpiry } = JSON.parse(readFileSync(TABLE, 'utf-8')) as {
  refreshSchedule: ScheduleCase[];
  tokenExpiry: ExpiryCase[];
};

const base64Url = (text: string): string => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A JWT carrying `claims`. Unsigned: nothing here verifies one. */
const tokenOf = (claims: object): string =>
  `${base64Url('{"alg":"none"}')}.${base64Url(JSON.stringify(claims))}.signature`;

describe('session — the SDK agrees with the shared table', () => {
  it('the table has cases of both kinds: a gate that runs nothing passes on silence', () => {
    expect(refreshSchedule.length).toBeGreaterThan(0);
    expect(tokenExpiry.length).toBeGreaterThan(0);
  });

  it.each(refreshSchedule)('refresh schedule: $why', (c) => {
    const token = c.token ?? tokenOf(c.claims ?? {});
    expect(refreshDelayMs(token, c.now * 1000)).toBe(c.delay === null ? null : c.delay * 1000);
  });

  it.each(tokenExpiry)('token expiry: $why', (c) => {
    expect(parseJwtExpiry(c.token)?.getTime() ?? null).toBe(c.exp === null ? null : c.exp * 1000);
  });
});
