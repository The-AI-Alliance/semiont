/**
 * The agent-token session every make-meaning sidecar holds (`agent-session.ts`).
 *
 * It replaced four byte-identical copies, and shipped with none of them
 * tested: the archivist, librarian, dispatcher and weaver entry points are
 * process-level and no suite imports them, so the one place a sidecar's
 * credential becomes a token — and stays one across a gateway restart — had
 * no spec. These pin the contract from the header:
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
 * The issuer half is mocked at `serviceAccountToken` (its own suite lives in
 * core); the gateway half is a stubbed global `fetch` answering real
 * `Response`s. Timers are fake, and the clock is pinned so `exp` arithmetic is
 * deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serviceAccountToken } from '@semiont/core';
import { startAgentSession, type AgentSession } from '../agent-session';

vi.mock('@semiont/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/core')>();
  return { ...actual, serviceAccountToken: vi.fn() };
});

const issuerToken = vi.mocked(serviceAccountToken);
const fetchMock = vi.fn<typeof fetch>();

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
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    issuerToken.mockReset();
    issuerToken.mockResolvedValue('issuer-token');
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

    expect(issuerToken).toHaveBeenCalledWith(credential);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://gateway.test/api/tokens/agent');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer issuer-token' },
      body: JSON.stringify({ provider: 'semiont', model: 'dispatcher' }),
    });
    expect(session.token$.value).toBe(agentToken);
    expect(logger.info).toHaveBeenCalledWith('Authenticated', { expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() });
  });

  it('a refused credential fails the first attempt loudly and is NOT retried', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401, statusText: 'Unauthorized' }));

    await expect(start()).rejects.toThrow('Authentication failed: 401 Unauthorized');
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
    expect(issuerToken).toHaveBeenCalledTimes(2);
  });

  // The schedule is `refreshDelayMs`, shared with `SemiontSession`
  // (proactive-refresh-margin-equals-token-lifetime, 2026-09-23). The margin
  // is a fraction of the token's OWN lifetime, so for these short-lived
  // fixtures the half-life governs where the old fixed margin did. This test
  // asserted the constant's arithmetic; it now asserts the derivation's, and
  // the behaviour it is really about — re-arming from the token just
  // received — is unchanged.
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
      .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(minted(second));
    const logger = makeLogger();
    session = await start(logger);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('Proactive re-authentication failed', {
      error: 'Authentication failed: 503 Service Unavailable',
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

  // ── REFRESH-FAILURE-TRANSIENT-VS-TERMINAL P3 ─────────────────────────
  // The browser session ended on ANY refresh failure; this one re-armed on any
  // failure forever. Neither disagreement was chosen. Both now read the same
  // named rule: the issuer's answer is the verdict, its absence never is.

  it('STOPS re-arming when the credential is refused — a revoked worker is not renewable', async () => {
    // The behaviour this phase adds. Re-arming forever against a credential an
    // administrator revoked is the case revocation exists to prevent, and it
    // was indistinguishable from riding out a restart.
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
