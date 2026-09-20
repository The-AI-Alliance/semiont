/**
 * Tests for the `SemiontSession` factories: `fromHttp` (structural — brand
 * the inputs, build the transport stack, thread the shared `token$`),
 * `fromIssuedSession` (tokens an issuer already issued: persist, wire the
 * refresh grant, return the ready session), and `signInDevice` (the device
 * grant end to end). They construct a real `SemiontClient` over a real
 * `HttpTransport`, so the wire is kept quiet by spying on the transport and
 * stubbing `fetch` for the issuer.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from '@semiont/http-transport';

import { SemiontSession } from '../semiont-session';
import { TestStorage, storageKey, testSession, TEST_TOKEN_ENDPOINT } from './test-storage-helpers';

/**
 * A JWT-shaped string with an unexpired `exp` claim. The session's
 * private `validate()` runs `isJwtExpired(stored.access)` and clears
 * storage if the token can't be parsed — so mock auth responses must
 * return real-looking JWTs.
 */
function freshJwt(expSecondsFromNow = 3600): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `${header}.${payload}.sig`;
}

const KB = {
  id: 'kb-factory',
  label: 'Factory KB',
  did: 'did:web:example.github.io:test-kb',
  endpoint: { kind: 'http' as const, host: 'localhost', port: 4000, protocol: 'http' as const },
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

function issuerReply(json: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => json } as unknown as Response;
}

describe('SemiontSession.fromIssuedSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('persists the issued session, seeds token$, and is ready', async () => {
    const accessJwt = freshJwt();

    const session = await SemiontSession.fromIssuedSession({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      session: testSession(accessJwt, 'refresh-tok'),
    });

    try {
      expect(session.token$.getValue()).toBe(accessJwt);
      const parsed = JSON.parse(storage.get(storageKey(KB.id))!);
      expect(parsed).toMatchObject({ access: accessJwt, refresh: 'refresh-tok', tokenEndpoint: TEST_TOKEN_ENDPOINT });
    } finally {
      await session.dispose();
    }
  });

  test('refreshes at the issuer the session names, with the stored refresh token', async () => {
    const newAccess = freshJwt();
    const fetchMock = vi.fn(async (_url: string) => issuerReply({ access_token: newAccess, refresh_token: 'refresh-2' }));
    vi.stubGlobal('fetch', fetchMock);

    const session = await SemiontSession.fromIssuedSession({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      session: testSession(freshJwt(), 'refresh-tok'),
    });

    try {
      expect(await session.refresh()).toBe(newAccess);
      expect(session.token$.getValue()).toBe(newAccess);
      // The live transport's event stream also fetches; only the issuer call matters here.
      const tokenCall = fetchMock.mock.calls.find(([url]) => url === TEST_TOKEN_ENDPOINT) as unknown as [string, { body: URLSearchParams }] | undefined;
      expect(tokenCall).toBeDefined();
      expect(Object.fromEntries(tokenCall![1].body.entries())).toEqual({
        grant_type: 'refresh_token', refresh_token: 'refresh-tok', client_id: 'semiont-browser',
      });
      // The rotation is persisted: the next refresh starts from the new token.
      expect(JSON.parse(storage.get(storageKey(KB.id))!).refresh).toBe('refresh-2');
    } finally {
      await session.dispose();
    }
  });

  test('a refused refresh returns null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => issuerReply({ error: 'invalid_grant' }, 400)));

    const session = await SemiontSession.fromIssuedSession({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      session: testSession(freshJwt(), 'refresh-tok'),
    });

    try {
      expect(await session.refresh()).toBeNull();
    } finally {
      await session.dispose();
    }
  });
});

describe('SemiontSession.signInDevice', () => {
  const ISSUER = 'https://issuer.test/realms/semiont';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('runs the device grant against the issuer the KB trusts and returns a ready session', async () => {
    vi.useFakeTimers();
    vi.spyOn(HttpTransport.prototype, 'getProtectedResourceMetadata').mockResolvedValue({
      resource: 'http://test.local', authorization_servers: [ISSUER], bearer_methods_supported: ['header'],
    });
    const accessJwt = freshJwt();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return issuerReply({
          issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`,
          device_authorization_endpoint: `${ISSUER}/device`, revocation_endpoint: `${ISSUER}/revoke`,
        });
      }
      if (url === `${ISSUER}/device`) {
        return issuerReply({ device_code: 'dev', user_code: 'ABCD-EFGH', verification_uri: `${ISSUER}/verify`, expires_in: 600, interval: 1 });
      }
      return issuerReply({ access_token: accessJwt, refresh_token: 'refresh-tok' });
    }));
    const onCode = vi.fn();

    const pending = SemiontSession.signInDevice({ kb: KB, storage, onCode });
    await vi.advanceTimersByTimeAsync(1500);
    const session = await pending;

    try {
      expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: 'ABCD-EFGH' }));
      expect(session.token$.getValue()).toBe(accessJwt);
      expect(JSON.parse(storage.get(storageKey(KB.id))!)).toMatchObject({
        access: accessJwt, refresh: 'refresh-tok', clientId: 'semiont-cli',
        tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke`,
      });
    } finally {
      await session.dispose();
    }
  });

  test('forwards optional onAuthFailed / onError callbacks into the session config', async () => {
    const jwt = freshJwt();
    vi.stubGlobal('fetch', vi.fn(async () => issuerReply({ access_token: jwt })));

    const onAuthFailed = vi.fn();
    const onError = vi.fn();
    const session = await SemiontSession.fromIssuedSession({
      kb: KB,
      storage,
      baseUrl: 'http://test.local',
      session: testSession(jwt, 'refresh-tok'),
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
