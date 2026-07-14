/**
 * The worker's stamped identity is the DID the `/api/tokens/agent` exchange
 * MINTED, carried verbatim — never re-derived from the URL the worker dials.
 * Pins Lane A of .plans/bugs/agent-did-host-skew.md at the unit level: the
 * fixture dials 192.168.64.1 while the exchange mints did:web:kb.example —
 * pre-fix code stamped the dial host (one logical agent, two DIDs).
 *
 * `worker-process` is module-mocked: the assertion seam is exactly what
 * `startAgentWorker` hands it as `generator`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@semiont/core';
import { startAgentWorker, authenticateAgent, parseBackendUrl, type AgentGroup } from '../worker-runtime';
import { startWorkerProcess } from '../worker-process';
import type { InferenceClient } from '@semiont/inference';

vi.mock('../worker-process', () => ({
  startWorkerProcess: vi.fn(() => ({ dispose: vi.fn() })),
}));

// The skew fixture: the worker DIALS a gateway IP…
const DIAL_URL = 'http://192.168.64.1:4000';
// …while the exchange mints the canonical identity from the backend's
// site.domain — a different host, deliberately.
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
    inference: { type: 'anthropic', model: 'claude-haiku-4-5' },
    jobTypes: ['reference-annotation', 'generation'],
    client: {} as InferenceClient, // never invoked — worker-process is mocked
  };
}

/**
 * Fetch router: answers the agent-token exchange; leaves SSE hanging open
 * (a stream that never emits); 200 `{}` for anything else the session
 * plumbing touches.
 */
function installFetchStub(): { exchangeCalls: Array<Record<string, unknown>> } {
  const exchangeCalls: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/tokens/agent')) {
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
  return { exchangeCalls };
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
      backendBaseUrl: DIAL_URL,
      workerSecret: 'test-secret',
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

  it('authenticateAgent posts the secret to the dial URL and returns the mint verbatim', async () => {
    const { exchangeCalls } = installFetchStub();

    const result = await authenticateAgent({
      backendBaseUrl: DIAL_URL,
      workerSecret: 'test-secret',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });

    expect(result.did).toBe(CANONICAL_DID);
    expect(exchangeCalls).toEqual([
      { secret: 'test-secret', provider: 'anthropic', model: 'claude-haiku-4-5' },
    ]);
  });

  it('authenticateAgent throws naming the agent on a non-200 exchange', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' })));

    await expect(
      authenticateAgent({ backendBaseUrl: DIAL_URL, workerSecret: 'bad', provider: 'anthropic', model: 'm1' }),
    ).rejects.toThrow(/anthropic:m1.*401/);
  });

  it('authenticateAgent refuses to run without a worker secret', async () => {
    await expect(
      authenticateAgent({ backendBaseUrl: DIAL_URL, workerSecret: '', provider: 'anthropic', model: 'm1' }),
    ).rejects.toThrow(/SEMIONT_WORKER_SECRET/);
  });

  it('parseBackendUrl keeps its connection role: host/port/protocol from the dial string', () => {
    expect(parseBackendUrl('http://192.168.64.1:4000')).toEqual({ protocol: 'http', host: '192.168.64.1', port: 4000 });
    expect(parseBackendUrl('https://kb.example')).toEqual({ protocol: 'https', host: 'kb.example', port: 443 });
  });
});
