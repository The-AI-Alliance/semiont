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
  const { Subject } = await import('rxjs');
  class MockSemiontApiClient {
    dispose = mockDispose;
    state$ = mockStateSubject;
    bus = { get: () => ({ next: () => {}, subscribe: () => ({ unsubscribe: () => {} }) }) };
    transport = (() => {
      const errorsSubject = new Subject();
      return { errorsSubject, errors$: errorsSubject.asObservable() };
    })();
  }
  return {
    ...actual,
    SemiontClient: MockSemiontApiClient,
  };
});

import { SemiontClient, APIError } from '../../client';
import { SemiontSession, type SemiontSessionConfig } from '../semiont-session';
import type { AccessToken } from '@semiont/core';
import { SESSION_PREFIX_RE, storageKey, seedStoredSession, testSession, TestStorage } from './test-storage-helpers';
import { getStoredSession } from '../storage';

function freshJwt(expSecondsFromNow = 3600): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `${header}.${payload}.sig`;
}

const KB = {
  id: 'kb-alpha',
  label: 'Alpha',
  endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
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

  it('survives a THROWN refresh during startup — `ready` resolves, it does not reject', async () => {
    // The startup path refreshes an expired stored token before validating,
    // and a refresh that throws there ends the session like one that returns
    // null. A throw there used to escape `validate()` and reject `ready`, so
    // an unreachable gateway did not merely fail to sign in — it broke
    // session CONSTRUCTION for every caller awaiting it.
    const expired = freshJwt(-3600);
    seedStoredSession(storage, KB.id, expired, 'refresh-tok');
    refresh.mockRejectedValue(new Error('ECONNREFUSED'));

    const session = newSession();
    await expect(session.ready).resolves.toBeUndefined();
    expect(session.user$.getValue()).toBeNull();
    expect(getStoredSession(storage, KB.id)).toBeNull();

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

  // ── A refresh margin equal to the token lifetime (2026-09-23) ───────
  // The unit tests above drive `refresh()` DIRECTLY, so a schedule that fires
  // at `delay = 0` is indistinguishable from one that fires correctly — which
  // is precisely why nothing caught a signed-in tab issuing 1418 successful
  // `POST /token` in ten idle seconds. This one asserts the SCHEDULE.

  it('does not storm: an idle session on a 300s token refreshes about once per half-life', async () => {
    vi.useFakeTimers();
    try {
      // 300s is the collision exactly: Keycloak's default lifespan, and what
      // the old fixed five-minute margin was subtracted from.
      const b64 = (o: unknown) => btoa(JSON.stringify(o));
      // Minted fresh on every call, as a real issuer does — `iat` moves. A
      // fixture that returns one fixed token instead ages past its own
      // half-life and measures the FLOOR, not the schedule.
      const mint = () => {
        const iat = Math.floor(Date.now() / 1000);
        return `${b64({ alg: 'none' })}.${b64({ iat, exp: iat + 300 })}.sig`;
      };
      seedStoredSession(storage, KB.id, mint(), 'refresh-tok');
      refresh.mockImplementation(async () => mint());

      const session = newSession();
      await session.ready;
      refresh.mockClear();

      // Half the lifetime, less a moment: nothing is due yet.
      await vi.advanceTimersByTimeAsync(149_000);
      expect(refresh, 'refreshed before its half-life').not.toHaveBeenCalled();

      // Past the half-life: exactly one refresh, and the token it returns
      // schedules the next one another half-life out rather than immediately.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(refresh).toHaveBeenCalledTimes(1);

      // Ten more minutes at one refresh per half-life is four, plus the one
      // already counted. The old rule produced 1418 in ten SECONDS.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(refresh.mock.calls.length, 'refresh count over ten minutes').toBeLessThanOrEqual(6);

      await session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires onAuthFailed when refresh returns null', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'refresh-tok');
    refresh.mockResolvedValue(null);
    const onAuthFailed = vi.fn();

    const session = newSession({ onAuthFailed });
    await session.ready;

    await session.refresh();
    expect(onAuthFailed).toHaveBeenCalledWith('expired');
    expect(session.token$.getValue()).toBeNull();

    await session.dispose();
  });

  // ── A thrown refresh is a failed refresh ────────────────────────────
  // A refresh callback makes an HTTP call, so it can THROW as easily as it can
  // return null — a network blip, DNS failure, or gateway 5xx. Both mean the
  // same thing to the session (this token cannot be renewed), so both must
  // land on the same terminal path. Before this, a throw escaped `refresh()`
  // and skipped all four terminal behaviours; via the proactive timer's
  // `void this.refresh()` it became an unhandled rejection with no further
  // refresh ever scheduled — a session holding an expired token forever,
  // which is the shape of the 401-loop incident.

  it('a THROWN refresh terminates the session exactly like one that returns null', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'refresh-tok');
    refresh.mockRejectedValue(new Error('ECONNREFUSED'));
    const onAuthFailed = vi.fn();
    const onError = vi.fn();

    const session = newSession({ onAuthFailed, onError });
    await session.ready;

    // It must not propagate: the caller (and the proactive timer) treat this
    // as "no token", not as an exception to handle.
    await expect(session.refresh()).resolves.toBeNull();

    expect(session.token$.getValue()).toBeNull();
    expect(getStoredSession(storage, KB.id)).toBeNull();
    expect(onAuthFailed).toHaveBeenCalledWith('expired');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'session.refresh-exhausted' }),
    );

    await session.dispose();
  });

  it('names the cause when a refresh throws — a network failure must not read as a revoked session', async () => {
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'refresh-tok');
    refresh.mockRejectedValue(new Error('ECONNREFUSED'));
    const onError = vi.fn();

    const session = newSession({ onError });
    await session.ready;
    await session.refresh();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('ECONNREFUSED') }),
    );

    await session.dispose();
  });

  it('a revoked refresh (refresh→null) clears the stored session so the dead token is not reused', async () => {
    // When the issuer refuses the refresh (the grant was revoked), the factory's
    // performRefresh resolves null, and the session must end: token cleared,
    // stored session cleared (so the dead refresh token is never replayed),
    // and the session ended as expired.
    const jwt = freshJwt();
    seedStoredSession(storage, KB.id, jwt, 'revoked-refresh-tok');
    refresh.mockResolvedValue(null);
    const onAuthFailed = vi.fn();

    const session = newSession({ onAuthFailed });
    await session.ready;

    const result = await session.refresh();

    expect(result).toBeNull();
    expect(session.token$.getValue()).toBeNull();
    expect(getStoredSession(storage, KB.id)).toBeNull();
    expect(onAuthFailed).toHaveBeenCalledWith('expired');

    await session.dispose();
  });
});

describe('SemiontSession — a refusal while the session is still starting', () => {
  // The session's stream opens with the stored token as the session starts
  // asking who that token is, so the stream's refusal can land first. While
  // the session is starting, `refresh` only renews: the start finds the
  // renewed token and asks about it. ONE renewal, ONE ask about it, ONE end.
  it('renews once and ends once when the stream is refused before the start has its answer', async () => {
    const stored = freshJwt(3600);
    const renewed = freshJwt(7200);
    seedStoredSession(storage, KB.id, stored, 'refresh-tok');
    const refusal = () => APIError.fromStatus('HTTP 401', 401, 'Unauthorized', undefined, undefined);
    // The gateway's answer about the stored token is held until released.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const asked: string[] = [];
    validate = vi.fn(async (token: AccessToken) => {
      asked.push(token);
      if (token === stored) await held;
      throw refusal();
    }) as typeof validate;
    refresh = vi.fn(async () => renewed) as typeof refresh;
    const onAuthFailed = vi.fn();
    const onError = vi.fn();
    const session = newSession({ onAuthFailed, onError });

    // The stream's refusal: renewed, and nobody asked. The start does that.
    expect(await session.refresh()).toBe(renewed);
    expect(asked).toEqual([stored]);

    // The start's answer about the stored token arrives: refused. It finds
    // the token renewed, asks about that one, and is refused again.
    release();
    await session.ready;

    expect(asked).toEqual([stored, renewed]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onAuthFailed).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls.map(([error]) => error.code)).toEqual(['session.credential-refused']);
    expect(session.token$.getValue()).toBeNull();
    await session.dispose();
  });

  it('leaves the asking to the start when the start and the stream are both waiting on one renewal', async () => {
    const stored = freshJwt(3600);
    const renewed = freshJwt(7200);
    seedStoredSession(storage, KB.id, stored, 'refresh-tok');
    // One renewal serves both askers, as renewals asked for together do.
    let issue!: (token: string) => void;
    const renewal = new Promise<string>((resolve) => { issue = resolve; });
    refresh = vi.fn(() => renewal) as typeof refresh;
    // The gateway refuses the stored token at once, and holds its answer
    // about the renewed one until released.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const asked: string[] = [];
    validate = vi.fn(async (token: AccessToken) => {
      asked.push(token);
      if (token === renewed) await held;
      throw APIError.fromStatus('HTTP 401', 401, 'Unauthorized', undefined, undefined);
    }) as typeof validate;
    const onAuthFailed = vi.fn();
    const onError = vi.fn();
    const session = newSession({ onAuthFailed, onError });

    // The start is refused and asks for a renewal; so does the stream.
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const refreshing = session.refresh();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    issue(renewed);
    await vi.waitFor(() => expect(asked).toEqual([stored, renewed]));
    release();
    await session.ready;

    expect(await refreshing).toBe(renewed);
    expect(asked).toEqual([stored, renewed]);
    expect(onAuthFailed).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls.map(([error]) => error.code)).toEqual(['session.credential-refused']);
    await session.dispose();
  });

  it('takes up a token renewed meanwhile as the just-issued one, and does not renew again', async () => {
    const stored = freshJwt(3600);
    const renewed = freshJwt(7200);
    seedStoredSession(storage, KB.id, stored, 'refresh-tok');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const asked: string[] = [];
    validate = vi.fn(async (token: AccessToken) => {
      asked.push(token);
      if (token === renewed) return { did: 'did:web:example.org:users:alice', email: 'a@b.c', name: 'Alice', image: null, domain: 'example.org' };
      await held;
      throw APIError.fromStatus('HTTP 401', 401, 'Unauthorized', undefined, undefined);
    }) as typeof validate;
    refresh = vi.fn(async () => renewed) as typeof refresh;
    const onAuthFailed = vi.fn();
    const session = newSession({ onAuthFailed });

    // The stream's refusal: renewed, and nobody asked.
    expect(await session.refresh()).toBe(renewed);
    expect(asked).toEqual([stored]);

    // The start's answer about the stored token arrives: refused. The
    // session's token is already the renewed one, which the gateway accepted.
    release();
    await session.ready;

    expect(asked).toEqual([stored, renewed]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(session.token$.getValue()).toBe(renewed);
    expect(session.user$.getValue()).toMatchObject({ name: 'Alice' });
    expect(onAuthFailed).not.toHaveBeenCalled();
    await session.dispose();
  });
});

describe('SemiontSession — a refusal of a running session', () => {
  const ALICE = { did: 'did:web:example.org:users:alice', email: 'a@b.c', name: 'Alice', image: null, domain: 'example.org' };
  const refusal = () => APIError.fromStatus('HTTP 401', 401, 'Unauthorized', undefined, undefined);

  it('answers refusals that arrive together with one renewal and one ask', async () => {
    const stored = freshJwt(3600);
    const renewed = freshJwt(7200);
    seedStoredSession(storage, KB.id, stored, 'refresh-tok');
    const asked: string[] = [];
    validate = vi.fn(async (token: AccessToken) => {
      asked.push(token);
      return ALICE;
    }) as typeof validate;
    refresh = vi.fn(async () => renewed) as typeof refresh;
    const session = newSession();
    await session.ready;

    // Three requests refused at once: each asks the session to refresh.
    const given = await Promise.all([session.refresh(), session.refresh(), session.refresh()]);

    expect(given).toEqual([renewed, renewed, renewed]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([stored, renewed]);

    // A refusal after that is a new one.
    await session.refresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    await session.dispose();
  });

  it('is not ended by the refusal of a token it no longer holds', async () => {
    const stored = freshJwt(3600);
    const renewed = freshJwt(7200);
    const elsewhere = freshJwt(9000);
    seedStoredSession(storage, KB.id, stored, 'refresh-tok');
    // The gateway holds its answer about the renewed token until released.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    validate = vi.fn(async (token: AccessToken) => {
      if (token !== renewed) return ALICE;
      await held;
      throw refusal();
    }) as typeof validate;
    refresh = vi.fn(async () => renewed) as typeof refresh;
    const onAuthFailed = vi.fn();
    const session = newSession({ onAuthFailed });
    await session.ready;

    const refreshing = session.refresh();
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(2));
    // Another context signs in again while the gateway is being asked.
    storage.dispatch(storageKey(KB.id), JSON.stringify({ ...testSession(elsewhere, 'r2') }));
    release();

    expect(await refreshing).toBe(elsewhere);
    expect(session.token$.getValue()).toBe(elsewhere);
    expect(onAuthFailed).not.toHaveBeenCalled();
    await session.dispose();
  });
});

describe('SemiontSession — instance identity', () => {
  // `kb.id` says WHICH knowledge base; `session.id` says WHICH LIVE SESSION
  // of it. Consumers that bind derived state to a session (React state units
  // keyed on it) need the second: `signIn` on an already-active KB disposes
  // and reconstructs the session under an unchanged `kb.id`, and anything
  // keyed on `kb.id` alone would keep pointing at the disposed client.

  it('gives every session a distinct id, including successive sessions for the SAME kb', async () => {
    const first = newSession();
    const second = newSession();
    await Promise.all([first.ready, second.ready]);

    expect(first.kb.id).toBe(second.kb.id);
    expect(typeof first.id).toBe('string');
    expect(first.id).not.toBe('');
    expect(first.id).not.toBe(second.id);

    await first.dispose();
    await second.dispose();
  });

  it('id is stable across the session lifetime, including after dispose', async () => {
    const session = newSession();
    await session.ready;
    const atStart = session.id;

    await session.dispose();
    expect(session.id).toBe(atStart);
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
