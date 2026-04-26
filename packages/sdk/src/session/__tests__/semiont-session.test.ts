/**
 * SemiontSession — unit tests for lifecycle, token wiring, and the
 * refresh/validate callback contract.
 *
 * `SemiontClient` is mocked at the module level (the session only
 * uses it to propagate token$ into HTTP calls; the test harness
 * doesn't exercise any real HTTP or SSE). Auth is parameterized
 * entirely through callbacks now, so tests provide `refresh` and
 * optional `validate` directly rather than mocking `client.auth.me` /
 * `client.auth.refresh`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BehaviorSubject, firstValueFrom, skip, take } from 'rxjs';

const mockDispose = vi.fn();
const mockStateSubject = { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) };

vi.mock('../../client', async () => {
  const actual = await vi.importActual<typeof import('../../client')>('../../client');
  class MockSemiontApiClient {
    dispose = mockDispose;
    state$ = mockStateSubject;
    bus = { get: () => ({ next: () => {}, subscribe: () => ({ unsubscribe: () => {} }) }) };
  }
  return {
    ...actual,
    SemiontClient: MockSemiontApiClient,
  };
});

import { SemiontClient } from '../../client';
import { SemiontSession, type SemiontSessionConfig } from '../semiont-session';
import type { AccessToken } from '@semiont/core';
import { SESSION_PREFIX_RE, storageKey, seedStoredSession, TestStorage } from './test-storage-helpers';

function freshJwt(expSecondsFromNow = 3600): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `${header}.${payload}.sig`;
}

const KB = {
  id: 'kb-alpha',
  label: 'Alpha',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'alice@example.com',
};

let storage: TestStorage;
let refresh: SemiontSessionConfig['refresh'] & ReturnType<typeof vi.fn>;
let validate: NonNullable<SemiontSessionConfig['validate']> & ReturnType<typeof vi.fn>;

/** Shortcut: new session with the default test callbacks. */
function newSession(overrides?: Partial<SemiontSessionConfig>): SemiontSession {
  // The mock SemiontClient ignores its constructor args; pass dummies.
  const client = new (SemiontClient as unknown as new (...args: unknown[]) => SemiontClient)();
  const token$ = new BehaviorSubject<AccessToken | null>(null);
  return new SemiontSession({
    kb: KB,
    storage,
    client,
    token$,
    refresh,
    validate,
    ...overrides,
  });
}

beforeEach(() => {
  storage = new TestStorage();
  mockDispose.mockReset();
  refresh = vi.fn<() => Promise<string | null>>(async () => null) as typeof refresh;
  validate = vi.fn<NonNullable<SemiontSessionConfig['validate']>>(
    async () => ({ id: 'u1', email: 'a@b.c', name: 'Alice', isAdmin: false, isModerator: false } as any),
  ) as typeof validate;
});

afterEach(() => {
  // Tests that create sessions should dispose them inside the test.
});

describe('SemiontSession — construction & initial token', () => {
  it('starts with null token when no stored session', async () => {
    const session = newSession();
    expect(session.token$.getValue()).toBeNull();
    expect(session.user$.getValue()).toBeNull();
    await session.ready;
    await session.dispose();
  });

  it('starts with stored token when unexpired, then populates user$ via the validate callback', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'refresh-tok');

    const session = newSession();
    expect(session.token$.getValue()).toBe(jwt);

    await session.ready;
    expect(validate).toHaveBeenCalled();
    expect(session.user$.getValue()).toMatchObject({ name: 'Alice' });

    await session.dispose();
  });

  it('skips user validation when no validate callback is provided (service principal)', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'refresh-tok');

    const session = newSession({ validate: undefined });
    await session.ready;

    // Token is still current, but there's no user to validate against
    expect(session.token$.getValue()).toBe(jwt);
    expect(session.user$.getValue()).toBeNull();
    expect(validate).not.toHaveBeenCalled();

    await session.dispose();
  });

  it('stays with null user$ if stored token is expired and refresh returns null', async () => {
    const expired = freshJwt(-3600);
    seedStoredSession(storage, KB.id, expired, 'refresh-tok');
    refresh.mockResolvedValue(null);

    const session = newSession();
    await session.ready;
    expect(session.user$.getValue()).toBeNull();
    expect(storage.get(storageKey(KB.id))).toBeNull();

    await session.dispose();
  });
});

describe('SemiontSession — refresh', () => {
  it('calls the configured refresh callback and pushes the new token into token$', async () => {
    const jwt = freshJwt();
    const newJwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'refresh-tok');
    refresh.mockResolvedValue(newJwt);

    const session = newSession();
    await session.ready;

    const tok = await session.refresh();
    expect(tok).toBe(newJwt);
    expect(session.token$.getValue()).toBe(newJwt);

    await session.dispose();
  });

  it('fires onAuthFailed when refresh returns null', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'refresh-tok');
    refresh.mockResolvedValue(null);
    const onAuthFailed = vi.fn();

    const session = newSession({ onAuthFailed });
    await session.ready;

    await session.refresh();
    expect(onAuthFailed).toHaveBeenCalledWith(expect.stringContaining('session has expired'));
    expect(session.token$.getValue()).toBeNull();

    await session.dispose();
  });
});

describe('SemiontSession — dispose', () => {
  it('completes subjects and calls client.dispose on dispose', async () => {
    const session = newSession();
    await session.ready;

    let completed = false;
    session.token$.subscribe({ complete: () => { completed = true; } });

    await session.dispose();
    expect(completed).toBe(true);
    expect(mockDispose).toHaveBeenCalled();
  });

  it('dispose is idempotent', async () => {
    const session = newSession();
    await session.ready;
    await session.dispose();
    await session.dispose();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});

describe('SemiontSession — cross-context storage sync', () => {
  it('responds to a storage change that updates this KB\'s session key', async () => {
    const session = newSession();
    await session.ready;

    const newJwt = freshJwt();
    const nextToken = firstValueFrom(session.token$.pipe(skip(1), take(1)));
    storage.dispatch(storageKey(KB.id), JSON.stringify({ access: newJwt, refresh: 'r2' }));
    await expect(nextToken).resolves.toBe(newJwt);

    await session.dispose();
  });

  it('responds to a storage change that clears this KB\'s session', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'r');

    const session = newSession();
    await session.ready;
    expect(session.token$.getValue()).toBe(jwt);

    storage.dispatch(storageKey(KB.id), null);

    expect(session.token$.getValue()).toBeNull();
    expect(session.user$.getValue()).toBeNull();

    await session.dispose();
  });

  it('ignores storage changes for other keys', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'r');

    const session = newSession();
    await session.ready;

    storage.dispatch('semiont.session.OTHER_KB', JSON.stringify({ access: 'xyz', refresh: 'q' }));
    expect(session.token$.getValue()).toBe(jwt);

    await session.dispose();
  });
});

describe('test helpers sanity', () => {
  it('storage keys are scoped by kb id', () => {
    expect(storageKey(KB.id)).toMatch(SESSION_PREFIX_RE);
  });
});
