/**
 * The token session a worker and every sidecar holds (`agent-session.ts`).
 *
 * The entry points that start one (`*-main.ts`) are process-level and no
 * suite imports them, so this suite is the only spec for the one place a
 * process's credential becomes its token — and stays one across a gateway
 * restart. These pin the contract from the header:
 *
 *   - two round trips sign the agent in: the issuer's grant to its account,
 *     whose token is its bearer and lands in `token$`, and the gateway's
 *     answer to who that account is (`GET /api/users/me`), its DID;
 *   - a REFUSED credential fails the first attempt loudly and is not retried
 *     (the far end is up and said no); a CONNECTION failure is retried with
 *     backoff (the gateway may be mid-restart);
 *   - `refresh()` asks the issuer for a new grant on demand, pushes it, and
 *     asks the gateway nothing;
 *   - the proactive timer is armed from the token's OWN lifetime via
 *     `refreshDelayMs` — not a restated lifetime, and not a fixed margin —
 *     re-arms from every new token, survives a failed refresh, stops on a
 *     refused one, and schedules nothing for a token that carries no `exp`;
 *   - `stop()` disarms it.
 *
 * Global `fetch` is stubbed. It answers the issuer's discovery itself, and
 * hands the grant to `grant` and the gateway to `gateway`, which each test
 * scripts with real `Response`s. Each test signs in at an issuer of its own:
 * core remembers the token an issuer granted for as long as it lives. Timers
 * are fake, and the clock is pinned so `exp` arithmetic is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServiceAccountCredential } from '@semiont/core';
import { startAgentSession, type AgentSession } from '../agent-session';

/** The client-credentials grant, as each test scripts it. */
const grant = vi.fn<() => Response>();
/** The gateway: `GET /api/users/me`, as each test scripts it. */
const gateway = vi.fn<typeof fetch>();
const routed: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('/.well-known/openid-configuration')) return Response.json({ token_endpoint: `${new URL(url).origin}/token` });
  if (url.endsWith('/token')) return grant();
  return gateway(input, init);
};

const NOW = new Date('2026-09-21T12:00:00Z');
const DID = 'did:web:kb.test:agents:service-account-semiont-dispatcher';
let issuers = 0;
let credential: ServiceAccountCredential;

/** A structurally valid JWT whose payload is the only thing `parseJwtExpiry` reads. */
function jwt(payload: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(payload))}.s`;
}
/** A token expiring `msFromNow` after the pinned clock. */
function tokenExpiringIn(msFromNow: number, tag: string): string {
  return jwt({ exp: Math.floor((NOW.getTime() + msFromNow) / 1000), tag });
}

/** The issuer's grant of `token`, which it says lives `lifetimeMs`: as long as core may hold it. */
function granted(token: string, lifetimeMs: number): Response {
  return Response.json({ access_token: token, expires_in: lifetimeMs / 1000 });
}

function named(): Response {
  return Response.json({ did: DID, email: null, name: null, image: null, domain: 'kb.test' });
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function start(logger = makeLogger()) {
  return startAgentSession({ baseUrl: 'http://gateway.test', credential, logger });
}

describe('startAgentSession', () => {
  let session: AgentSession | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', routed);
    grant.mockReset();
    gateway.mockReset();
    gateway.mockImplementation(async () => named());
    credential = { issuer: `https://issuer-${++issuers}.test/realms/kb`, clientId: 'semiont-dispatcher', clientSecret: 'shh' };
    session = null;
  });

  afterEach(() => {
    session?.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('signs in as its account: the issuer\'s token is its bearer, and the gateway names it', async () => {
    const token = tokenExpiringIn(5 * 60 * 1000, 'first');
    grant.mockReturnValueOnce(granted(token, 5 * 60 * 1000));
    const logger = makeLogger();

    session = await start(logger);

    expect(grant).toHaveBeenCalledTimes(1);
    expect(gateway).toHaveBeenCalledTimes(1);
    const [url, init] = gateway.mock.calls[0]!;
    expect(url).toBe('http://gateway.test/api/users/me');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(session.token$.getValue()).toBe(token);
    // The DID is the gateway's, verbatim, and never re-derived from the URL dialled.
    expect(session.did).toBe(DID);
    expect(logger.info).toHaveBeenCalledWith('Authenticated', {
      did: DID,
      expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
    });
  });

  it('a token the gateway refuses fails the first attempt loudly and is NOT retried', async () => {
    grant.mockReturnValueOnce(granted(tokenExpiringIn(5 * 60 * 1000, 'first'), 5 * 60 * 1000));
    gateway.mockResolvedValueOnce(new Response('', { status: 401, statusText: 'Unauthorized' }));

    await expect(start()).rejects.toThrow('The gateway did not name the agent: HTTP 401 Unauthorized');
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it('an account the issuer refuses fails the first attempt loudly, and the gateway is never asked', async () => {
    grant.mockReturnValueOnce(new Response('{}', { status: 401 }));

    await expect(start()).rejects.toThrow(`Client-credentials grant for semiont-dispatcher at ${credential.issuer} failed (HTTP 401)`);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('a connection failure is retried with backoff until the gateway answers', async () => {
    const token = tokenExpiringIn(5 * 60 * 1000, 'after-retry');
    grant.mockImplementation(() => granted(token, 5 * 60 * 1000));
    gateway
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
      .mockImplementationOnce(async () => named());
    const logger = makeLogger();

    const starting = start(logger);
    // STARTUP_FETCH_RETRY's first wait is jittered inside [500, 1000) ms.
    await vi.advanceTimersByTimeAsync(1_000);
    session = await starting;

    expect(gateway).toHaveBeenCalledTimes(2);
    expect(session.token$.getValue()).toBe(token);
    expect(logger.warn).toHaveBeenCalledWith(
      'Gateway unreachable, retrying authentication',
      // Which request got no answer, and the code the runtime gave the failed connection.
      expect.objectContaining({ attempt: 1, error: 'http://gateway.test/api/users/me got no answer: ECONNREFUSED' }),
    );
  });

  it('refresh() asks the issuer for a new grant, pushes it, and asks the gateway nothing', async () => {
    // Each token the issuer grants could be held for an hour: a refresh is
    // asked because the gateway refused the one held, so it is a new grant.
    const first = tokenExpiringIn(60 * 60 * 1000, 'first');
    const second = tokenExpiringIn(2 * 60 * 60 * 1000, 'second');
    grant.mockReturnValueOnce(granted(first, 60 * 60 * 1000)).mockReturnValueOnce(granted(second, 2 * 60 * 60 * 1000));
    session = await start();

    const seen: Array<string | null> = [];
    session.token$.subscribe((t) => seen.push(t));

    await expect(session.refresh()).resolves.toBe(second);
    expect(seen).toEqual([first, second]);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(gateway, 'the account is who it was: its DID is not asked again').toHaveBeenCalledTimes(1);
  });

  // The schedule is `refreshDelayMs`, shared with `SemiontSession`. The margin
  // is a fraction of the token's OWN lifetime — a fixed margin as long as a
  // token's whole lifetime fires the refresh at zero delay, in a loop — so
  // for these short-lived fixtures the half-life governs. The arithmetic
  // asserted is the derivation's; the behaviour this is really about is
  // re-arming from the token just received.
  it('renews proactively before the token\'s own exp, then re-arms from the new one', async () => {
    // These fixtures carry `exp` but no `iat`, so the lifetime the schedule
    // sees is the life REMAINING when it schedules — which is the honest
    // reading when an issuer does not say when it minted.
    //   first:  400 s left at t=0   → margin 200 s → fires at t=200 s
    //   second: 600 s left at t=200 → margin 300 s (the cap) → fires at t=500 s
    // Each grant says it lives as long as its token, so core would hold the
    // first until t=370 s: a renewal that is due asks for a new grant all the same.
    const first = tokenExpiringIn(400_000, 'first');
    const second = tokenExpiringIn(800_000, 'second');
    const third = tokenExpiringIn(1_400_000, 'third');
    grant
      .mockReturnValueOnce(granted(first, 400_000))
      .mockReturnValueOnce(granted(second, 600_000))
      .mockReturnValueOnce(granted(third, 900_000));
    session = await start();

    await vi.advanceTimersByTimeAsync(199_000);
    expect(grant, 'nothing fires before the window').toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(session.token$.getValue()).toBe(second);

    // The second token has 600 s of life left from here, so the next refresh
    // is scheduled from IT — the issuer changed the lifetime and this process
    // learned the new schedule from the token, not from a constant.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(grant).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(grant).toHaveBeenCalledTimes(3);
    expect(session.token$.getValue()).toBe(third);
    expect(gateway, 'renewing asks the issuer alone').toHaveBeenCalledTimes(1);
  });

  it('a failed proactive refresh only logs, keeps the token in hand, and tries again', async () => {
    const first = tokenExpiringIn(400_000, 'first');
    const second = tokenExpiringIn(400_000 + 600_000, 'second');
    grant
      .mockReturnValueOnce(granted(first, 400_000))
      // The renewal is one grant: an issuer that says "not now" is waited
      // out by the schedule, and not by a retry inside the renewal.
      .mockReturnValueOnce(new Response('', { status: 503, statusText: 'Service Unavailable' }))
      .mockReturnValueOnce(granted(second, 800_000));
    const logger = makeLogger();
    session = await start(logger);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('Proactive re-authentication failed', {
      error: `Client-credentials grant for semiont-dispatcher at ${credential.issuer} failed (HTTP 503)`,
    });
    expect(session.token$.getValue(), 'a still-valid token is not thrown away over one bad round trip').toBe(first);

    // Re-armed from the token still in hand. It has 200 s left, so the retry
    // is 100 s out — not the floor. Each failure re-derives from what remains,
    // so attempts get closer together as expiry nears and stop shortening at
    // `MIN_REFRESH_DELAY_MS`: more urgent when it matters, never a spin.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(grant).toHaveBeenCalledTimes(3);
    expect(session.token$.getValue()).toBe(second);
  });

  // ── Refresh failure: an outage re-arms, a refusal stops ──────────────
  // This session and the browser's read the same named rule: the issuer's
  // answer is the verdict, its absence never is.

  it('STOPS re-arming when the credential is refused — a revoked worker is not renewable', async () => {
    // Re-arming forever against a credential an administrator revoked is the
    // case revocation exists to prevent, and it would be indistinguishable
    // from riding out a restart.
    const first = tokenExpiringIn(400_000, 'first');
    grant
      .mockReturnValueOnce(granted(first, 400_000))
      .mockReturnValueOnce(new Response('', { status: 401, statusText: 'Unauthorized' }));
    const logger = makeLogger();
    session = await start(logger);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(grant, 'the refusal was received').toHaveBeenCalledTimes(2);

    // Long past any floor or half-life: nothing more is attempted.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(grant, 'a refusal ends the loop').toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      'Re-authentication refused; not retrying',
      expect.objectContaining({ error: expect.stringContaining('401') }),
    );
  });

  it('STOPS re-arming when the issuer refuses the grant with a 400, as it does on a 401', async () => {
    // An issuer refuses a client it no longer knows, or no longer lets use
    // the grant, with a 400 as readily as a 401 (RFC 6749 §5.2). Either is
    // its verdict, and re-arming against it is the same loop.
    const first = tokenExpiringIn(400_000, 'first');
    grant
      .mockReturnValueOnce(granted(first, 400_000))
      .mockReturnValueOnce(Response.json({ error: 'unauthorized_client' }, { status: 400, statusText: 'Bad Request' }));
    const logger = makeLogger();
    session = await start(logger);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(grant, 'the refusal was received').toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(grant, 'a refusal ends the loop').toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      'Re-authentication refused; not retrying',
      expect.objectContaining({ error: expect.stringContaining('(HTTP 400)') }),
    );
  });

  it('a token with no readable exp schedules nothing', async () => {
    grant.mockReturnValueOnce(Response.json({ access_token: jwt({ sub: 'no-exp' }) }));
    session = await start();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('stop() disarms the proactive refresh', async () => {
    grant.mockReturnValueOnce(granted(tokenExpiringIn(400_000, 'first'), 400_000));
    session = await start();

    session.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(grant).toHaveBeenCalledTimes(1);
  });
});
