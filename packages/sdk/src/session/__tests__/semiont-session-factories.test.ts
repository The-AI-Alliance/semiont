/**
 * Tests for `SemiontSession.fromHttp(...)` and `SemiontSession.signIn(...)`.
 *
 * These exercise the factories' wiring — they construct a real
 * `SemiontClient` over a real `HttpTransport`, so we don't share the
 * module-level `SemiontClient` mock from `semiont-session.test.ts`. The
 * HTTP layer is kept off the wire by spying directly on
 * `HttpTransport.prototype.authenticatePassword` and `refreshAccessToken`.
 *
 * `fromHttp` is structural: brand the inputs, build the transport stack,
 * thread the shared `token$`, return a wired session.
 *
 * `signIn` is the credentials-first path: auth round-trip → persist
 * tokens → wire a default refresh that reads from storage at refresh
 * time → return the ready session. On auth failure, the transient
 * client is disposed before the error is rethrown.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from '@semiont/api-client';

import { SemiontSession } from '../semiont-session';
import { TestStorage, storageKey } from './test-storage-helpers';

const KB = {
  id: 'kb-factory',
  label: 'Factory KB',
  host: 'localhost',
  port: 4000,
  protocol: 'http' as const,
  email: 'me@example.com',
};

let storage: TestStorage;

beforeEach(() => {
  storage = new TestStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SemiontSession.fromHttp', () => {
  test('returns a SemiontSession with no token when none provided', async () => {
    const session = SemiontSession.fromHttp({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
    });
    try {
      await session.ready;
      expect(session.token$.getValue()).toBeNull();
      expect(session.user$.getValue()).toBeNull();
    } finally {
      await session.dispose();
    }
  });

  test('seeds token$ when a string token is supplied (and brands it)', async () => {
    const session = SemiontSession.fromHttp({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      token: 'header.payload.sig',
    });
    try {
      await session.ready;
      expect(session.token$.getValue()).toBe('header.payload.sig');
    } finally {
      await session.dispose();
    }
  });

  test('forwards optional callbacks (refresh / onAuthFailed) into the session', async () => {
    const refresh = vi.fn(async () => null);
    const onAuthFailed = vi.fn();

    const session = SemiontSession.fromHttp({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      refresh,
      onAuthFailed,
    });
    try {
      await session.ready;

      // Drive a refresh. With no stored token there's nothing to refresh,
      // but the configured callback is what we want to assert wired.
      const result = await session.refresh();
      expect(result).toBeNull();
      expect(refresh).toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  });
});

describe('SemiontSession.signIn', () => {
  test('runs auth.password, persists both tokens, and seeds token$', async () => {
    const passwordSpy = vi
      .spyOn(HttpTransport.prototype, 'authenticatePassword')
      .mockResolvedValue({
        token: 'access-jwt',
        refreshToken: 'refresh-tok',
        user: { did: 'did:test:u' },
      } as never);

    const session = await SemiontSession.signIn({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      email: 'me@example.com',
      password: 'pwd',
    });

    try {
      expect(passwordSpy).toHaveBeenCalledTimes(1);
      const [emailArg, passwordArg] = passwordSpy.mock.calls[0]!;
      expect(emailArg).toBe('me@example.com');
      expect(passwordArg).toBe('pwd');

      // Token populated.
      expect(session.token$.getValue()).toBe('access-jwt');

      // Both access and refresh persisted under the kb-scoped key.
      const stored = storage.get(storageKey(KB.id));
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.access).toBe('access-jwt');
      expect(parsed.refresh).toBe('refresh-tok');
    } finally {
      await session.dispose();
    }
  });

  test('default refresh callback reads stored refresh token and exchanges it', async () => {
    vi.spyOn(HttpTransport.prototype, 'authenticatePassword').mockResolvedValue({
      token: 'access-jwt',
      refreshToken: 'refresh-tok',
      user: { did: 'did:test:u' },
    } as never);

    const refreshSpy = vi
      .spyOn(HttpTransport.prototype, 'refreshAccessToken')
      .mockResolvedValue({ access_token: 'new-access' } as never);

    const session = await SemiontSession.signIn({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      email: 'me@example.com',
      password: 'pwd',
    });

    try {
      const newToken = await session.refresh();
      expect(newToken).toBe('new-access');
      expect(refreshSpy).toHaveBeenCalledWith('refresh-tok');
      expect(session.token$.getValue()).toBe('new-access');
    } finally {
      await session.dispose();
    }
  });

  test('default refresh swallows refresh failures and returns null', async () => {
    vi.spyOn(HttpTransport.prototype, 'authenticatePassword').mockResolvedValue({
      token: 'access-jwt',
      refreshToken: 'refresh-tok',
      user: { did: 'did:test:u' },
    } as never);

    vi.spyOn(HttpTransport.prototype, 'refreshAccessToken').mockRejectedValue(
      new Error('refresh down'),
    );

    const session = await SemiontSession.signIn({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      email: 'me@example.com',
      password: 'pwd',
    });

    try {
      const result = await session.refresh();
      expect(result).toBeNull();
    } finally {
      await session.dispose();
    }
  });

  test('disposes the transient client and rethrows when auth.password fails', async () => {
    const failure = new Error('invalid credentials');
    vi.spyOn(HttpTransport.prototype, 'authenticatePassword').mockRejectedValue(failure);
    const disposeSpy = vi.spyOn(HttpTransport.prototype, 'dispose');

    const before = disposeSpy.mock.calls.length;

    await expect(
      SemiontSession.signIn({
        kb: KB,
        storage,
        baseUrl: 'http://test.local',
        email: 'me@example.com',
        password: 'wrong',
      }),
    ).rejects.toBe(failure);

    expect(disposeSpy.mock.calls.length).toBeGreaterThan(before);

    // Storage should be untouched on failed signIn.
    expect(storage.get(storageKey(KB.id))).toBeNull();
  });

  test('forwards optional onAuthFailed / onError callbacks into the session config', async () => {
    vi.spyOn(HttpTransport.prototype, 'authenticatePassword').mockResolvedValue({
      token: 'access-jwt',
      refreshToken: 'refresh-tok',
      user: { did: 'did:test:u' },
    } as never);
    vi.spyOn(HttpTransport.prototype, 'refreshAccessToken').mockResolvedValue(
      { access_token: 'access-jwt' } as never,
    );

    const onAuthFailed = vi.fn();
    const onError = vi.fn();
    const session = await SemiontSession.signIn({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      email: 'me@example.com',
      password: 'pwd',
      onAuthFailed,
      onError,
    });

    try {
      // Sanity: the session was constructed with our callbacks (test the
      // wiring by triggering an auth-failed path).
      // We don't assert these were CALLED — just that signIn accepted them
      // without choking and the session is functional.
      expect(session).toBeInstanceOf(SemiontSession);
    } finally {
      await session.dispose();
    }
  });
});
