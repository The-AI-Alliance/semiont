/**
 * The worker's stamped identity is the DID the `/api/tokens/agent` exchange
 * MINTED, carried verbatim — never re-derived from the URL the worker dials.
 * Pinned at the unit level: the fixture dials 192.168.64.1 while the exchange
 * mints did:web:kb.example — stamping the dial host would give one logical
 * agent two DIDs.
 *
 * `worker-process` is module-mocked: the assertion seam is exactly what
 * `startAgentWorker` hands it as `generator`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@semiont/core';
import { JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS } from '@semiont/sdk';
import { startAgentWorker, buildHealthPayload, WORKER_CHANNELS, WORKER_AWAITED_OPERATIONS, WORKER_ANSWERED_OPERATIONS, type AgentGroup, type AgentVitals } from '../worker-runtime';
import { startWorkerProcess } from '../worker-process';
import type { InferenceClient } from '@semiont/inference';

const { FAKE_ADAPTER_VITALS } = vi.hoisted(() => ({
  FAKE_ADAPTER_VITALS: {
    lastQueuedEventAt: '2026-07-17T00:00:00.000Z',
    lastClaimAt: null,
    lastFinishedAt: null,
    lastActivityAt: '2026-07-17T00:00:00.000Z',
    activeJob: null,
    jobsCompleted: 3,
  },
}));

vi.mock('../worker-process', () => ({
  startWorkerProcess: vi.fn(() => ({
    stop: vi.fn(async () => {}),
    vitals: vi.fn(() => FAKE_ADAPTER_VITALS),
  })),
}));

// The skew fixture: the worker DIALS a gateway IP…
const ISSUER = 'https://issuer.test';
const CREDENTIAL = { issuer: ISSUER, clientId: 'semiont-worker', clientSecret: 'client-secret' };
const DIAL_URL = 'http://192.168.64.1:4000';
// …while the exchange mints the canonical identity from the KB's own domain
// — a different host, deliberately.
const CANONICAL_DID = 'did:web:kb.example:agents:anthropic:claude-haiku-4-5';

/** Unsigned JWT with a far-future exp — enough for isJwtExpired to say "fresh". */
function fakeJwt(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: 4102444800 })}.sig`;
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Logger;

function makeGroup(): AgentGroup {
  return {
    agent: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    serves: [{ jobType: 'mark', params: { motivation: 'linking' } }, { jobType: 'yield' }],
    client: {} as InferenceClient, // never invoked — worker-process is mocked
  };
}

/**
 * Fetch router: answers the agent-token exchange; leaves SSE hanging open
 * (a stream that never emits); 200 `{}` for anything else the session
 * plumbing touches.
 */
function installFetchStub(): {
  exchangeCalls: Array<Record<string, unknown>>;
  exchangeAuth: string[];
} {
  const exchangeCalls: Array<Record<string, unknown>> = [];
  const exchangeAuth: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/.well-known/openid-configuration')) {
      return Response.json({ issuer: ISSUER, token_endpoint: `${ISSUER}/token` });
    }
    if (url.endsWith('/token')) {
      return Response.json({ access_token: 'service-account-token' });
    }
    if (url.includes('/api/tokens/agent')) {
      exchangeAuth.push(new Headers(init?.headers).get('authorization') ?? '');
      exchangeCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ token: fakeJwt(), did: CANONICAL_DID }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/bus/subscribe')) {
      return new Response(new ReadableStream({ start() { /* hold open */ } }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return { exchangeCalls, exchangeAuth };
}

describe('worker-runtime — identity is minted by the exchange, carried verbatim', () => {
  beforeEach(() => {
    vi.mocked(startWorkerProcess).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stamps the exchange-returned DID as generator — NOT the dial host (the host-skew pin)', async () => {
    installFetchStub();

    const worker = await startAgentWorker({
      group: makeGroup(),
      gatewayBaseUrl: DIAL_URL,
      credential: CREDENTIAL,
      reportsLimitsOf: [],
      logger: noopLogger,
    });

    expect(startWorkerProcess).toHaveBeenCalledTimes(1);
    const { generator } = vi.mocked(startWorkerProcess).mock.calls[0]![0];

    // The one assertion this file exists for: '@id' is the minted DID,
    // byte-for-byte — kb.example, not 192.168.64.1.
    expect(generator['@id']).toBe(CANONICAL_DID);
    expect(generator['@id']).not.toContain('192.168.64.1');
    expect(generator).toMatchObject({
      '@type': 'Software',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });

    await worker.dispose();
  });

  it('signs in as the agent its group works as, presenting its service account\'s token, and stops its claims when disposed', async () => {
    const { exchangeCalls, exchangeAuth } = installFetchStub();

    const worker = await startAgentWorker({
      group: makeGroup(),
      gatewayBaseUrl: DIAL_URL,
      credential: CREDENTIAL,
      reportsLimitsOf: [],
      logger: noopLogger,
    });

    // The body names what is WANTED; the header proves who is asking. The two
    // are separate because one process asks for several agent identities.
    expect(exchangeCalls).toEqual([{ provider: 'anthropic', model: 'claude-haiku-4-5' }]);
    expect(exchangeAuth).toEqual(['Bearer service-account-token']);

    // A job still held when the worker goes is failed by the stop, so the
    // queue retries it now and does not wait for its sweep.
    const claims = vi.mocked(startWorkerProcess).mock.results[0]!.value;
    await worker.dispose();
    expect(claims.stop).toHaveBeenCalledTimes(1);
  });
});

describe('worker-runtime — health vitals', () => {
  beforeEach(() => {
    vi.mocked(startWorkerProcess).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('startAgentWorker exposes vitals composing agent identity with the adapter snapshot', async () => {
    installFetchStub();

    const worker = await startAgentWorker({
      group: makeGroup(),
      gatewayBaseUrl: DIAL_URL,
      credential: CREDENTIAL,
      reportsLimitsOf: [],
      logger: noopLogger,
    });

    expect(worker.vitals()).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      did: CANONICAL_DID,
      serves: [{ jobType: 'mark', params: { motivation: 'linking' } }, { jobType: 'yield' }],
      ...FAKE_ADAPTER_VITALS,
    });

    await worker.dispose();
  });

  it('buildHealthPayload stays additive and reflects vitals advancing across cycles', () => {
    let stamp = '2026-07-17T00:00:00.000Z';
    const fakeWorker = {
      vitals: (): AgentVitals => ({
        provider: 'ollama',
        model: 'm',
        did: 'did:web:kb.example:agents:ollama:m',
        serves: [{ jobType: 'yield' }],
        lastQueuedEventAt: stamp,
        lastClaimAt: null,
        lastFinishedAt: null,
        lastActivityAt: stamp,
        activeJob: null,
        jobsCompleted: 0,
      }),
    };

    const first = buildHealthPayload([fakeWorker]);
    // Consumers read status/agents.
    expect(first).toMatchObject({ status: 'ok', agents: 1 });
    expect(first.workers[0]!.lastQueuedEventAt).toBe('2026-07-17T00:00:00.000Z');

    stamp = '2026-07-17T00:00:30.000Z';
    const second = buildHealthPayload([fakeWorker]);
    expect(second.workers[0]!.lastQueuedEventAt).toBe('2026-07-17T00:00:30.000Z');
  });
});

describe('worker-runtime — narrowed SSE subscription', () => {
  it('WORKER_CHANNELS is exactly the manifest: awaited replies PLUS declared broadcasts', () => {
    // An explicit pin, deliberately: growing a worker's subscription set must
    // stay a conscious edit to a literal list — that is the OOM protection.
    // The list names what the SDK's claiming names (`JOB_CLAIM_CHANNELS`:
    // its replies, and the two broadcasts it reads) and what a held job's
    // commit names (`JOB_COMMIT_CHANNELS`) as well as the reply channels of
    // what the worker itself awaits.
    expect([...WORKER_CHANNELS].sort()).toEqual([
      // Canonical-geometry consult replies — the pair without which every
      // PDF detection job fails.
      'browse:anchored-text-failed',
      'browse:anchored-text-result',
      // The durability probe for a commit whose ack never routed. The
      // SINGULAR annotation read, chosen precisely so the list channel below
      // stays out.
      'browse:annotation-failed',
      'browse:annotation-result',
      'browse:resource-failed',
      'browse:resource-result',
      'job:claim-failed',
      'job:claimed',
      // The durability ack. A worker whose held jobs commit but whose stream
      // does not name the commit's replies fails fast with `bus.unsubscribed`
      // on the first unit.
      'mark:commit-failed',
      'mark:commit-ok',
      // Declared broadcasts. Cooperative cancellation of the ACTIVE job:
      // note this is an operation REQUEST channel that the worker consumes
      // and never answers — the gateway's handler replies for PENDING jobs,
      // the worker aborts for RUNNING ones. Two consumers, one contract.
      'job:cancel-requested',
      // The queue announcement that wakes an idle worker. Without its
      // declaration every worker idles.
      'job:queued',
    ].sort());
  });

  it('every worker channel is an awaited reply, one the claiming names or one a commit names — the manifest cannot drift', async () => {
    // The set cannot drift from the registry, with the one legitimate
    // widening named. `job:cancel-requested` is NOT in BRIDGED_CHANNELS: it
    // is an operation request channel, so a plain "must be bridged" check
    // would reject exactly what the worker means to consume. Anything
    // outside the three sets is drift.
    const { BRIDGED_CHANNELS, replyChannelsFor } = await import('@semiont/core');
    const replies = new Set<string>([...replyChannelsFor(WORKER_AWAITED_OPERATIONS), ...JOB_COMMIT_CHANNELS]);
    const declared = new Set<string>(JOB_CLAIM_CHANNELS);
    for (const channel of WORKER_CHANNELS) {
      expect(
        replies.has(channel) || declared.has(channel),
        `${channel} is neither an awaited reply, nor one the claiming names, nor one a commit names`,
      ).toBe(true);
    }
    // The replies half must be registry-bridged: the worker's own awaits, and a commit's.
    for (const channel of replies) expect(BRIDGED_CHANNELS).toContain(channel);
  });

  it('the fat fan-out channels that OOM a worker are NOT subscribed', () => {
    expect(WORKER_CHANNELS).not.toContain('browse:annotations-result');
    expect(WORKER_CHANNELS).not.toContain('browse:resources-result');
  });
});

// The pool answers job:limits-requested once, on one agent's transport: the
// gateway delivers only the first reply to a request. Only that agent
// subscribes the request. Every other agent's transport would receive it with
// nobody to deliver it to, and the bus logs each such frame as a DROP.
describe('worker-runtime — one agent reports the pool\'s limits', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const subscribedChannels = () =>
    vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input instanceof Request ? input.url : input).includes('/bus/subscribe'))
      .map(([, init]) => (JSON.parse(String(init?.body ?? '{}')) as { global?: string[] }).global ?? []);

  it('an agent that reports limits subscribes job:limits-requested; one that does not, does not', async () => {
    for (const [reportsLimitsOf, subscribes] of [
      [[{ type: 'anthropic', modelId: 'claude-haiku-4-5', limits: async () => ({ contextTokens: 1, maxOutputTokens: 1 }) }], true],
      [[], false],
    ] as const) {
      installFetchStub();
      const worker = await startAgentWorker({
        group: makeGroup(),
        gatewayBaseUrl: DIAL_URL,
        credential: CREDENTIAL,
        reportsLimitsOf,
        logger: noopLogger,
      });
      const channels = subscribedChannels().flat();
      expect(channels.length, 'the transport subscribed nothing').toBeGreaterThan(0);
      expect(channels.includes('job:limits-requested'), `reportsLimitsOf has ${reportsLimitsOf.length}`).toBe(subscribes);
      for (const op of WORKER_ANSWERED_OPERATIONS) expect(channels.includes(op)).toBe(subscribes);
      await worker.dispose();
      vi.unstubAllGlobals();
    }
  });
});
