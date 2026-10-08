/**
 * The agent-token session a worker and every sidecar holds (`agent-session.ts`).
 *
 * The entry points that start one (`*-main.ts`) are process-level and no
 * suite imports them, so this suite is the only spec for the one place a
 * process's credential becomes a token — and stays one across a gateway
 * restart. These pin the contract from the header:
 *
 *   - two round trips: the issuer (service-account credential) then the
 *     gateway (`POST /api/tokens/agent`), the agent token landing in `token$`;
 *   - a REFUSED credential fails the first attempt loudly and is not retried
 *     (the far end is up and said no); a CONNECTION failure is retried with
 *     backoff (the gateway may be mid-restart);
 *   - `refresh()` re-authenticates on demand and pushes the new token;
 *   - the proactive timer is armed from the token's OWN lifetime via
 *     `refreshDelayMs` — not a restated lifetime, and not a fixed margin —
 *     re-arms from every new token, survives a failed refresh, and schedules
 *     nothing for a token that carries no `exp`;
 *   - `stop()` disarms it.
 *
 * Global `fetch` is stubbed. It answers the issuer itself (discovery, and a
 * grant with no `expires_in`, which core therefore does not keep), and hands
 * the exchange to `fetchMock`, which each test scripts with real `Response`s.
 * Timers are fake, and the clock is pinned so `exp` arithmetic is
 * deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startAgentSession, type AgentSession } from '../agent-session';

/** The exchange: `POST /api/tokens/agent`, as each test scripts it. */
const fetchMock = vi.fn<typeof fetch>();
/** How many client-credentials grants the issuer has been asked for. */
let grants = 0;
const routed: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('/.well-known/openid-configuration')) return Response.json({ token_endpoint: 'https://issuer.test/realms/kb/token' });
  if (url.endsWith('/token')) {
    grants += 1;
    return Response.json({ access_token: 'issuer-token' });
  }
  return fetchMock(input, init);
};

const NOW = new Date('2026-09-21T12:00:00Z');
const credential = { issuer: 'https://issuer.test/realms/kb', clientId: 'semiont-dispatcher', clientSecret: 'shh' };

/** A structurally valid JWT whose payload is the only thing `parseJwtExpiry` reads. */
function jwt(payload: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(payload))}.s`;
}
/** A token expiring `msFromNow` after the pinned clock. */
function tokenExpiringIn(msFromNow: number, tag: string): string {
  return jwt({ exp: Math.floor((NOW.getTime() + msFromNow) / 1000), tag });
}

function minted(token: string): Response {
  return new Response(JSON.stringify({ token, did: 'did:web:kb.test:agents:semiont:dispatcher' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function start(logger = makeLogger()) {
  return startAgentSession({ baseUrl: 'http://gateway.test', credential, provider: 'semiont', model: 'dispatcher', logger });
}

describe('startAgentSession', () => {
  let session: AgentSession | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', routed);
    fetchMock.mockReset();
    grants = 0;
    session = null;
  });

  afterEach(() => {
    session?.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('authenticates in two round trips and holds the agent token', async () => {
    const agentToken = tokenExpiringIn(60 * 60 * 1000, 'first');
    fetchMock.mockResolvedValueOnce(minted(agentToken));
    const logger = makeLogger();

    session = await start(logger);

    expect(grants).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://gateway.test/api/tokens/agent');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer issuer-token');
    expect(init?.body).toBe(JSON.stringify({ provider: 'semiont', model: 'dispatcher' }));
    expect(session.token$.value).toBe(agentToken);
    // The DID is the gateway's, verbatim, and never re-derived from the URL dialled.
    expect(session.did).toBe('did:web:kb.test:agents:semiont:dispatcher');
    expect(logger.info).toHaveBeenCalledWith('Authenticated', {
      did: 'did:web:kb.test:agents:semiont:dispatcher',
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    });
  });

  it('a refused credential fails the first attempt loudly and is NOT retried', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401, statusText: 'Unauthorized' }));

    await expect(start()).rejects.toThrow('The gateway refused the agent token of semiont:dispatcher: HTTP 401 Unauthorized');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a connection failure is retried with backoff until the gateway answers', async () => {
    const agentToken = tokenExpiringIn(60 * 60 * 1000, 'after-retry');
    fetchMock
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(minted(agentToken));
    const logger = makeLogger();

    const starting = start(logger);
    // STARTUP_FETCH_RETRY's first wait is jittered inside [500, 1000) ms.
    await vi.advanceTimersByTimeAsync(1_000);
    session = await starting;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.token$.value).toBe(agentToken);
    expect(logger.warn).toHaveBeenCalledWith(
      'Gateway unreachable, retrying authentication',
      expect.objectContaining({ attempt: 1, error: 'fetch failed' }),
    );
  });

  it('refresh() re-authenticates on demand and pushes the new token', async () => {
    const first = tokenExpiringIn(60 * 60 * 1000, 'first');
    const second = tokenExpiringIn(2 * 60 * 60 * 1000, 'second');
    fetchMock.mockResolvedValueOnce(minted(first)).mockResolvedValueOnce(minted(second));
    session = await start();

    const seen: Array<string | null> = [];
    session.token$.subscribe((t) => seen.push(t));

    await expect(session.refresh()).resolves.toBe(second);
    expect(seen).toEqual([first, second]);
    expect(grants, 'each sign-in proves the process again').toBe(2);
  });

  // The schedule is `refreshDelayMs`, shared with `SemiontSession`. The margin
  // is a fraction of the token's OWN lifetime — a fixed margin as long as a
  // token's whole lifetime fires the refresh at zero delay, in a loop — so
  // for these short-lived fixtures the half-life governs. The arithmetic
  // asserted is the derivation's; the behaviour this is really about is
  // re-arming from the token just received.
  it('re-authenticates proactively before the token\'s own exp, then re-arms from the new one', async () => {
    // These fixtures carry `exp` but no `iat`, so the lifetime the schedule
    // sees is the life REMAINING when it schedules — which is the honest
    // reading when an issuer does not say when it minted.
    //   first:  400 s left at t=0   → margin 200 s → fires at t=200 s
    //   second: 600 s left at t=200 → margin 300 s (the cap) → fires at t=500 s
    const first = tokenExpiringIn(400_000, 'first');
    const second = tokenExpiringIn(800_000, 'second');
    const third = tokenExpiringIn(1_400_000, 'third');
    fetchMock.mockResolvedValueOnce(minted(first)).mockResolvedValueOnce(minted(second)).mockResolvedValueOnce(minted(third));
    session = await start();

    await vi.advanceTimersByTimeAsync(199_000);
    expect(fetchMock, 'nothing fires before the window').toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.token$.value).toBe(second);

    // The second token has 600 s of life left from here, so the next refresh
    // is scheduled from IT — the gateway changed the lifetime and this process
    // learned the new schedule from the token, not from a constant.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(session.token$.value).toBe(third);
  });

  it('a failed proactive refresh only logs, keeps the token in hand, and tries again', async () => {
    const first = tokenExpiringIn(400_000, 'first');
    const second = tokenExpiringIn(400_000 + 600_000, 'second');
    fetchMock
      .mockResolvedValueOnce(minted(first))
      // A 500 and not a 503: the sign-in itself tries a "not now" again, and
      // this is the failure it does not.
      .mockResolvedValueOnce(new Response('', { status: 500, statusText: 'Internal Server Error' }))
      .mockResolvedValueOnce(minted(second));
    const logger = makeLogger();
    session = await start(logger);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('Proactive re-authentication failed', {
      error: 'The gateway refused the agent token of semiont:dispatcher: HTTP 500 Internal Server Error',
    });
    expect(session.token$.value, 'a still-valid token is not thrown away over one bad round trip').toBe(first);

    // Re-armed from the token still in hand. It has 200 s left, so the retry
    // is 100 s out — not the floor. Each failure re-derives from what remains,
    // so attempts get closer together as expiry nears and stop shortening at
    // `MIN_REFRESH_DELAY_MS`: more urgent when it matters, never a spin.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(session.token$.value).toBe(second);
  });

  // ── Refresh failure: an outage re-arms, a refusal stops ──────────────
  // This session and the browser's read the same named rule: the issuer's
  // answer is the verdict, its absence never is.

  it('STOPS re-arming when the credential is refused — a revoked worker is not renewable', async () => {
    // Re-arming forever against a credential an administrator revoked is the
    // case revocation exists to prevent, and it would be indistinguishable
    // from riding out a restart.
    const first = tokenExpiringIn(400_000, 'first');
    fetchMock
      .mockResolvedValueOnce(minted(first))
      .mockResolvedValueOnce(new Response('', { status: 401, statusText: 'Unauthorized' }));
    const logger = makeLogger();
    session = await start(logger);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock, 'the refusal was received').toHaveBeenCalledTimes(2);

    // Long past any floor or half-life: nothing more is attempted.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock, 'a refusal ends the loop').toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      'Re-authentication refused; not retrying',
      expect.objectContaining({ error: expect.stringContaining('401') }),
    );
  });

  it('a token with no readable exp schedules nothing', async () => {
    fetchMock.mockResolvedValueOnce(minted(jwt({ sub: 'no-exp' })));
    session = await start();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stop() disarms the proactive refresh', async () => {
    fetchMock.mockResolvedValueOnce(minted(tokenExpiringIn(400_000, 'first')));
    session = await start();

    session.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
