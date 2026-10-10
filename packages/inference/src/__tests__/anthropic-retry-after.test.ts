/**
 * How long the Anthropic driver waits before a request is asked again.
 *
 * The askings and the waits between them are the library's. What is this
 * driver's is the longest wait a refusal may state and still be waited: two
 * minutes. A refusal that says longer is not waited and the request is not
 * made again, and the failure says the wait the provider stated.
 *
 * These tests run the library itself, and no double of it: `fetch` is the
 * provider they play, and the clock is theirs to move. So they also hold what
 * the driver leans on in the library: that it waits as long as a refusal
 * says, and that it does not ask again for a refusal marked
 * `x-should-retry: false`. A release of the library that stops doing either
 * fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicInferenceClient } from '../implementations/anthropic.js';
import { ProviderStatusError } from '../interface.js';

/** One request, as it reached the played provider. */
interface Asked {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  /** When it arrived, by the clock the test moves. */
  at: number;
}

/** What the played provider says to one request: made anew each time, since an answer is read once. */
type Answer = () => Response;

const said = (status: number, body: unknown, headers: Record<string, string> = {}): Answer => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const MODEL = said(200, {
  type: 'model',
  id: 'claude-x',
  display_name: 'Claude, played',
  created_at: '2026-01-01T00:00:00Z',
  max_input_tokens: 200_000,
  max_tokens: 64_000,
  capabilities: { structured_outputs: { supported: true } },
});

const answered = (text: string): Answer =>
  said(200, {
    id: 'msg_played',
    type: 'message',
    role: 'assistant',
    model: 'claude-x',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 1 },
  });

/** A 429 that says when to ask again, in the header named. `beside` is what else its headers say. */
const toldToWait = (header: string, stated: string, beside: Record<string, string> = {}): Answer =>
  said(429, { type: 'error', error: { type: 'rate_limit_error', message: 'the account is over its rate' } }, { [header]: stated, ...beside });

/** What a failure says, after the refusal itself, of a wait the provider stated and the driver does not wait. */
const notWaited = (header: string, stated: string): string =>
  `; the provider said to wait (${header}: ${stated}), which is longer than the 120 seconds this driver waits`;

/** What a failure says, where it is one. */
const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : `not a failure: ${String(failure)}`);

const asked: Asked[] = [];
/** What the next requests of each kind are answered with, in order. With none left, the Models API and the probe answer as a model that is there does. */
const script: { models: Answer[]; probes: Answer[]; generations: Answer[] } = { models: [], probes: [], generations: [] };

const retrievals = (): Asked[] => asked.filter((a) => a.method === 'GET');
const probes = (): Asked[] => asked.filter((a) => a.method === 'POST' && a.body?.['max_tokens'] === 1);
const generations = (): Asked[] => asked.filter((a) => a.method === 'POST' && a.body?.['max_tokens'] !== 1);

/** `wanted`, with the clock moved ahead until it settles: what it would wait out, it waits out at once. */
async function hurried<T>(wanted: Promise<T>): Promise<T> {
  let settled = false;
  const watched = wanted.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  // Three hours at the most: longer than any wait these tests have a provider state.
  for (let seconds = 0; !settled && seconds < 3 * 3600; seconds++) await vi.advanceTimersByTimeAsync(1000);
  await watched;
  return wanted;
}

beforeEach(() => {
  asked.length = 0;
  script.models = [];
  script.probes = [];
  script.generations = [];
  // The clock the library waits by, and reads a date against. Nothing else of the platform's is played.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const request: Asked = {
      method,
      path: url.pathname,
      body: typeof body === 'object' && body !== null ? Object.fromEntries(Object.entries(body)) : undefined,
      at: Date.now(),
    };
    asked.push(request);
    if (method === 'GET' && url.pathname === '/v1/models/claude-x') return (script.models.shift() ?? MODEL)();
    if (method === 'POST' && url.pathname === '/v1/messages') {
      if (request.body?.['max_tokens'] === 1) return (script.probes.shift() ?? answered('ok'))();
      const next = script.generations.shift();
      if (next !== undefined) return next();
    }
    return said(500, { type: 'error', error: { type: 'api_error', message: `the played provider has nothing scripted for ${method} ${url.pathname}` } })();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const driver = (): AnthropicInferenceClient => new AnthropicInferenceClient('sk-played-key', 'claude-x', 'http://played.invalid');

describe('AnthropicInferenceClient - a wait the provider states before a generation is asked again', () => {
  it.each([
    ['retry-after', '120'],
    ['retry-after-ms', '120000'],
  ])('waits two minutes when the refusal says %s: %s, and asks again', async (header, stated) => {
    script.generations = [toldToWait(header, stated), answered('answered at the second asking')];

    expect(await hurried(driver().generateText('p', 100, 0))).toBe('answered at the second asking');

    const [first, second] = generations();
    expect(generations()).toHaveLength(2);
    expect(second!.at - first!.at).toBe(120_000);
  });

  it.each([
    ['retry-after', '121', 100],
    ['retry-after-ms', '120001', 100],
    ['retry-after', '3600', 100],
    // Asked for as a stream, a refusal is the same refusal.
    ['retry-after', '121', 21_334],
  ])('does not wait when the refusal says %s: %s, and does not ask again (%i tokens asked for)', async (header, stated, maxTokens) => {
    script.generations = [toldToWait(header, stated), answered('answered at a second asking, which is never made')];

    const failure: unknown = await hurried(driver().generateText('p', maxTokens, 0).catch((err: unknown) => err));

    // The refusal's own status, so it is classed as any refusal is: and what the provider said, with the wait it stated.
    expect(failure).toBeInstanceOf(ProviderStatusError);
    expect(failure).toMatchObject({ status: 429, message: expect.stringContaining('the account is over its rate') });
    expect(messageOf(failure).slice(-notWaited(header, stated).length)).toBe(notWaited(header, stated));
    expect(generations()).toHaveLength(1);
  });

  it('waits for a date the refusal states when it is within two minutes, and not when it is later', async () => {
    // A date states no part of a second, so it is up to one second sooner than asked for here.
    const inSeconds = (seconds: number): string => new Date(Date.now() + seconds * 1000).toUTCString();
    const later = inSeconds(300);
    script.generations = [toldToWait('retry-after', inSeconds(60)), answered('first'), toldToWait('retry-after', later)];
    const client = driver();

    expect(await hurried(client.generateText('p', 100, 0))).toBe('first');
    const [first, second] = generations();
    expect(second!.at - first!.at).toBeGreaterThan(59_000);
    expect(second!.at - first!.at).toBeLessThanOrEqual(60_000);

    const failure: unknown = await hurried(client.generateText('p', 100, 0).catch((err: unknown) => err));
    expect(failure).toBeInstanceOf(ProviderStatusError);
    expect(failure).toMatchObject({ status: 429, message: expect.stringContaining(`(retry-after: ${later})`) });
    expect(generations()).toHaveLength(3);
  });

  it('does not ask again for a refusal the provider marks to be asked again, when the wait it states is over two minutes', async () => {
    // The provider's own `x-should-retry: true` would have the library ask again whatever the wait. The wait decides.
    script.generations = [toldToWait('retry-after', '121', { 'x-should-retry': 'true' }), answered('never asked for')];

    const failure: unknown = await hurried(driver().generateText('p', 100, 0).catch((err: unknown) => err));

    expect(failure).toBeInstanceOf(ProviderStatusError);
    expect(failure).toMatchObject({ status: 429 });
    expect(generations()).toHaveLength(1);
  });
});

describe('AnthropicInferenceClient - a wait the provider states before a discovery is asked again', () => {
  it.each([
    ['retry-after', '121'],
    ['retry-after-ms', '121000'],
  ])('asks the Models API once when it says %s: %s, and the failure states the wait', async (header, stated) => {
    script.models = [toldToWait(header, stated), MODEL];

    const failure: unknown = await hurried(driver().limits().catch((err: unknown) => err));

    expect(failure).toBeInstanceOf(ProviderStatusError);
    expect(failure).toMatchObject({
      status: 429,
      message: `Failed to discover model limits for 'claude-x' from the Models API: refused with status 429${notWaited(header, stated)}`,
    });
    expect(retrievals()).toHaveLength(1);
    expect(probes()).toHaveLength(0);
  });

  it('waits for a Models API that says two minutes, and asks it three times in all', async () => {
    script.models = [toldToWait('retry-after', '120'), toldToWait('retry-after', '120'), toldToWait('retry-after', '120')];

    const failure: unknown = await hurried(driver().limits().catch((err: unknown) => err));

    // A wait that was waited is not spoken of: the failure is the refusal's alone.
    expect(failure).toMatchObject({ status: 429, message: "Failed to discover model limits for 'claude-x' from the Models API: refused with status 429" });
    const at = retrievals().map((a) => a.at);
    expect(at).toHaveLength(3);
    expect([at[1]! - at[0]!, at[2]! - at[1]!]).toEqual([120_000, 120_000]);
  });

  it('asks the probe once when it says to wait over two minutes, and the failure states the wait', async () => {
    script.probes = [toldToWait('retry-after', '121')];
    script.generations = [answered('answered once the model is learned of, which it is not')];

    const failure: unknown = await hurried(driver().generateText('p', 100, 0).catch((err: unknown) => err));

    expect(failure).toBeInstanceOf(ProviderStatusError);
    expect(failure).toMatchObject({
      status: 429,
      message: `Sampling-parameter probe failed for 'claude-x': refused with status 429${notWaited('retry-after', '121')}`,
    });
    expect(probes()).toHaveLength(1);
    expect(generations()).toHaveLength(0);
  });
});
