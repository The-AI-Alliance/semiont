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
import { createServer, type Server } from 'http';
import { once } from 'events';
import type { AddressInfo } from 'net';

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

  // The blip that used to be fatal: any momentary backend unreachability
  // at the instant the worker starts (backend restart, container-network
  // warm-up) threw `TypeError: fetch failed` straight out of main() and
  // killed the process — with `--rm` and no restart policy, permanently.
  it('retries startup auth while the backend is unreachable and succeeds once it comes up', async () => {
    // Reserve a port, then free it — the first attempts dial a closed port
    // and fail at the connection level, exactly like a backend mid-restart.
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    await once(probe, 'close');

    let backend: Server | undefined;
    const bringUp = setTimeout(() => {
      backend = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: fakeJwt(), did: CANONICAL_DID }));
      });
      backend.listen(port, '127.0.0.1');
    }, 150);

    const warn = vi.fn();
    try {
      const result = await authenticateAgent({
        backendBaseUrl: `http://127.0.0.1:${port}`,
        workerSecret: 'test-secret',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        logger: { ...noopLogger, warn } as unknown as Logger,
        retry: { attempts: 20, initialDelayMs: 50, maxDelayMs: 100 },
      });
      expect(result.did).toBe(CANONICAL_DID);
      expect(warn).toHaveBeenCalledWith(
        'Backend unreachable, retrying agent authentication',
        expect.objectContaining({ agent: 'anthropic:claude-haiku-4-5', attempt: expect.any(Number) }),
      );
    } finally {
      clearTimeout(bringUp);
      if (backend) {
        backend.close();
        await once(backend, 'close');
      }
    }
  }, 15_000);

  it('gives up after the retry budget when the backend never comes up', async () => {
    const calls = { count: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.count++;
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }));

    await expect(
      authenticateAgent({
        backendBaseUrl: DIAL_URL,
        workerSecret: 'test-secret',
        provider: 'anthropic',
        model: 'm1',
        retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
      }),
    ).rejects.toThrow('fetch failed');
    expect(calls.count).toBe(3);
  });

  it('does NOT retry an HTTP-level rejection — the backend is up and said no', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      authenticateAgent({
        backendBaseUrl: DIAL_URL,
        workerSecret: 'bad',
        provider: 'anthropic',
        model: 'm1',
        retry: { attempts: 5, initialDelayMs: 1, maxDelayMs: 2 },
      }),
    ).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parseBackendUrl keeps its connection role: host/port/protocol from the dial string', () => {
    expect(parseBackendUrl('http://192.168.64.1:4000')).toEqual({ protocol: 'http', host: '192.168.64.1', port: 4000 });
    expect(parseBackendUrl('https://kb.example')).toEqual({ protocol: 'https', host: 'kb.example', port: 443 });
  });
});
