/**
 * How a client holds a session is one table, specs/src/session/cases.json, run
 * here through the SDK's own schedule and token reader. Every SDK that holds a
 * session runs the same table: a mirror across implementations, gated by one
 * table rather than generated.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BehaviorSubject } from 'rxjs';
import type { AccessToken } from '@semiont/core';
import { APIError } from '../../client';
import { createTestClient } from '../../testing';
import { httpKb } from '../knowledge-base';
import { SemiontSession, type UserInfo } from '../semiont-session';
import type { SemiontSessionError } from '../errors';
import type { SessionEndReason } from '../session-signals';
import { InMemorySessionStorage } from '../session-storage';
import { getStoredSession, parseJwtExpiry, refreshDelayMs, setStoredSession } from '../storage';
import { userId } from '@semiont/core';

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

interface StartupCase {
  why: string;
  stored: 'unexpired' | 'expired' | 'none';
  /** What the gateway answers each time it is asked; the last answer repeats. */
  gateway: Array<'accepts' | 'refuses' | 'unreachable'>;
  /** What the issuer answers each renewal; the last answer repeats. */
  issuer: Array<'renews' | 'refuses'>;
  asks: number;
  renewals: number;
  ends: 'signed-in' | 'signed-out' | 'unconfirmed';
  told: SessionEndReason | null;
  error: string | null;
  kept: boolean;
}

interface RefusalCase {
  why: string;
  /** What the issuer answers the renewal. */
  issuer: Array<'renews' | 'refuses'>;
  /** What the gateway answers when asked who the renewed token is. */
  gateway: Array<'accepts' | 'refuses' | 'unreachable'>;
  asks: number;
  renewals: number;
  given: boolean;
  ends: 'signed-in' | 'signed-out' | 'unconfirmed';
  told: SessionEndReason | null;
  error: string | null;
  kept: boolean;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../specs/src/session/cases.json');
const { refreshSchedule, tokenExpiry, startup, refusal } = JSON.parse(readFileSync(TABLE, 'utf-8')) as {
  refreshSchedule: ScheduleCase[];
  tokenExpiry: ExpiryCase[];
  startup: StartupCase[];
  refusal: RefusalCase[];
};

const base64Url = (text: string): string => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A JWT carrying `claims`. Unsigned: nothing here verifies one. */
const tokenOf = (claims: object): string =>
  `${base64Url('{"alg":"none"}')}.${base64Url(JSON.stringify(claims))}.signature`;

describe('session — the SDK agrees with the shared table', () => {
  it('the table has cases of both kinds: a gate that runs nothing passes on silence', () => {
    expect(refreshSchedule.length).toBeGreaterThan(0);
    expect(tokenExpiry.length).toBeGreaterThan(0);
    expect(startup.length).toBeGreaterThan(0);
    expect(refusal.length).toBeGreaterThan(0);
  });

  it.each(refreshSchedule)('refresh schedule: $why', (c) => {
    const token = c.token ?? tokenOf(c.claims ?? {});
    expect(refreshDelayMs(token, c.now * 1000)).toBe(c.delay === null ? null : c.delay * 1000);
  });

  it.each(tokenExpiry)('token expiry: $why', (c) => {
    expect(parseJwtExpiry(c.token)?.getTime() ?? null).toBe(c.exp === null ? null : c.exp * 1000);
  });

  const KB = httpKb({ id: 'kb-alpha', label: 'Alpha', host: 'localhost', port: 4000, protocol: 'http' });
  const ALICE: UserInfo = {
    did: userId('did:web:example.org:users:alice'),
    email: 'alice@example.org',
    name: 'Alice',
    image: null,
    domain: 'example.org',
  };

  /** The `n`th answer of a script whose last answer repeats. */
  const answer = <T>(script: T[], n: number): T => script[Math.min(n, script.length - 1)]!;

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(startup)('startup: $why', async (c) => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const issued = (n: number): string => tokenOf({ iat: now, exp: now + 3600, n });
    const storage = new InMemorySessionStorage();
    if (c.stored !== 'none') {
      setStoredSession(storage, KB.id, {
        access: c.stored === 'expired' ? tokenOf({ iat: now - 600, exp: now - 300 }) : issued(0),
        refresh: 'a-refresh-token',
        clientId: 'semiont-browser',
        tokenEndpoint: 'https://issuer.test/token',
      });
    }

    let asks = 0;
    let renewals = 0;
    const told: SessionEndReason[] = [];
    const errors: SemiontSessionError[] = [];
    const token$ = new BehaviorSubject<AccessToken | null>(null);
    const session = new SemiontSession({
      kb: KB,
      storage,
      client: createTestClient().client,
      token$,
      validate: async () => {
        asks += 1;
        // The script's last answer repeats, so a session that asks without
        // end is stopped here, by an answer that is no refusal.
        if (asks > c.asks) throw new Error(`the gateway was asked ${asks} times`);
        switch (answer(c.gateway, asks - 1)) {
          case 'accepts':
            return ALICE;
          case 'refuses':
            throw APIError.fromStatus('HTTP 401', 401, 'Unauthorized', undefined, undefined);
          case 'unreachable':
            throw APIError.withoutResponse('GET /api/users/me got no answer', 'NetworkError');
        }
      },
      refresh: async () => {
        renewals += 1;
        if (renewals > c.renewals) throw new Error(`the issuer was asked ${renewals} times`);
        return answer(c.issuer, renewals - 1) === 'renews' ? issued(renewals) : null;
      },
      onAuthFailed: (reason) => told.push(reason),
      onError: (error) => errors.push(error),
    });
    await session.ready;

    expect({ asks, renewals }).toEqual({ asks: c.asks, renewals: c.renewals });
    const [token, user] = [token$.getValue(), session.user$.getValue()];
    expect(token === null ? 'signed-out' : user === null ? 'unconfirmed' : 'signed-in').toBe(c.ends);
    expect(told).toEqual(c.told === null ? [] : [c.told]);
    expect(errors.map((error) => error.code)).toEqual(c.error === null ? [] : [c.error]);
    expect(getStoredSession(storage, KB.id) !== null).toBe(c.kept);

    // A session that ended signed out asks nobody anything afterwards,
    // however long it is held.
    if (c.ends === 'signed-out') {
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect({ asks, renewals }).toEqual({ asks: c.asks, renewals: c.renewals });
    }
    await session.dispose();
  });

  it.each(refusal)('refusal: $why', async (c) => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const issued = (n: number): string => tokenOf({ iat: now, exp: now + 3600, n });
    const storage = new InMemorySessionStorage();
    setStoredSession(storage, KB.id, {
      access: issued(0),
      refresh: 'a-refresh-token',
      clientId: 'semiont-browser',
      tokenEndpoint: 'https://issuer.test/token',
    });

    let started = false;
    let asks = 0;
    let renewals = 0;
    const told: SessionEndReason[] = [];
    const errors: SemiontSessionError[] = [];
    const token$ = new BehaviorSubject<AccessToken | null>(null);
    const session = new SemiontSession({
      kb: KB,
      storage,
      client: createTestClient().client,
      token$,
      validate: async () => {
        // The session starts signed in: the gateway accepts the stored token.
        if (!started) return ALICE;
        asks += 1;
        if (asks > c.asks) throw new Error(`the gateway was asked ${asks} times`);
        switch (answer(c.gateway, asks - 1)) {
          case 'accepts':
            return ALICE;
          case 'refuses':
            throw APIError.fromStatus('HTTP 401', 401, 'Unauthorized', undefined, undefined);
          case 'unreachable':
            throw APIError.withoutResponse('GET /api/users/me got no answer', 'NetworkError');
        }
      },
      refresh: async () => {
        renewals += 1;
        if (renewals > c.renewals) throw new Error(`the issuer was asked ${renewals} times`);
        if (answer(c.issuer, renewals - 1) !== 'renews') return null;
        const renewed = issued(renewals);
        setStoredSession(storage, KB.id, { ...getStoredSession(storage, KB.id)!, access: renewed });
        return renewed;
      },
      onAuthFailed: (reason) => told.push(reason),
      onError: (error) => errors.push(error),
    });
    await session.ready;
    expect(session.user$.getValue()).toEqual(ALICE);
    started = true;

    // The gateway refused the session's token: its transport asks it to refresh.
    const given = await session.refresh();

    expect({ asks, renewals }).toEqual({ asks: c.asks, renewals: c.renewals });
    expect(given !== null).toBe(c.given);
    if (c.given) expect(given).toBe(token$.getValue());
    const [token, user] = [token$.getValue(), session.user$.getValue()];
    expect(token === null ? 'signed-out' : user === null ? 'unconfirmed' : 'signed-in').toBe(c.ends);
    expect(told).toEqual(c.told === null ? [] : [c.told]);
    expect(errors.map((error) => error.code)).toEqual(c.error === null ? [] : [c.error]);
    expect(getStoredSession(storage, KB.id) !== null).toBe(c.kept);

    if (c.ends === 'signed-out') {
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect({ asks, renewals }).toEqual({ asks: c.asks, renewals: c.renewals });
    }
    await session.dispose();
  });

  it('a renewal on the session\'s own schedule follows no refusal, and asks nobody', async () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const issued = (n: number): string => tokenOf({ iat: now, exp: now + 3600, n });
    const storage = new InMemorySessionStorage();
    setStoredSession(storage, KB.id, {
      access: issued(0),
      refresh: 'a-refresh-token',
      clientId: 'semiont-browser',
      tokenEndpoint: 'https://issuer.test/token',
    });
    let asks = 0;
    let renewals = 0;
    const session = new SemiontSession({
      kb: KB,
      storage,
      client: createTestClient().client,
      token$: new BehaviorSubject<AccessToken | null>(null),
      validate: async () => {
        asks += 1;
        return ALICE;
      },
      refresh: async () => {
        renewals += 1;
        return issued(renewals);
      },
    });
    await session.ready;
    expect({ asks, renewals }).toEqual({ asks: 1, renewals: 0 });

    // An hour-long token is renewed 300 seconds before it expires.
    await vi.advanceTimersByTimeAsync(3300 * 1000);

    expect({ asks, renewals }).toEqual({ asks: 1, renewals: 1 });
    await session.dispose();
  });
});

