/**
 * Every embedding round trip acquires from one gate, and its deadline starts
 * when it runs.
 *
 * Each provider declares how many of its requests may be in flight, and every
 * round trip acquires from one gate held on the provider INSTANCE. A limit
 * inside a call would be multiplied by the number of concurrent callers, which
 * is not a cap at all.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaEmbeddingProvider, OLLAMA_CONCURRENCY } from '../embedding/ollama';
import { VoyageEmbeddingProvider, VOYAGE_CONCURRENCY } from '../embedding/voyage';

afterEach(() => { vi.unstubAllGlobals(); });

/** Ollama's wire shape: one embedding per input, echoed back in order. */
const ollamaReply = (inputs: string[]) =>
  new Response(JSON.stringify({ embeddings: inputs.map((t) => [t.length, 0.1]) }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

/** Voyage's wire shape: `data[].embedding`. */
const voyageReply = (inputs: string[]) =>
  new Response(JSON.stringify({ data: inputs.map((t) => ({ embedding: [t.length, 0.1] })) }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

function inputsOf(call: [string, RequestInit]): string[] {
  return JSON.parse(String(call[1].body)).input as string[];
}

/** The two providers, each with the reply shape its own API returns. */
const providers = [
  {
    name: 'ollama',
    concurrency: OLLAMA_CONCURRENCY,
    make: () => new OllamaEmbeddingProvider({ model: 'nomic-embed-text' }),
    reply: ollamaReply,
  },
  {
    name: 'voyage',
    concurrency: VOYAGE_CONCURRENCY,
    make: () => new VoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-3' }),
    reply: voyageReply,
  },
] as const;

// The same table runs against both providers: gating one and not the other
// would leave the provider that has a rate limit with no ceiling.
describe.each(providers)('$name', ({ concurrency, make, reply }) => {
  it('embeds one text in one round trip', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      reply(JSON.parse(String(init.body)).input));
    vi.stubGlobal('fetch', fetchMock);

    const out = await make().embed('solo');

    expect(out).toEqual([4, 0.1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inputsOf(fetchMock.mock.calls[0] as [string, RequestInit])).toEqual(['solo']);
  });

  it('never exceeds the provider\'s concurrency, even across concurrent callers', async () => {
    // The cap is on the provider INSTANCE, not the call: two callers sharing a
    // provider share its ceiling. A per-call limiter passes the test above and
    // fails this one — which is the whole point of the gate.
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return reply(JSON.parse(String(init.body)).input);
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = make();

    await Promise.all(Array.from({ length: concurrency * 3 }, (_, i) => provider.embed(`t${i}`)));

    expect(fetchMock).toHaveBeenCalledTimes(concurrency * 3);
    expect(peak).toBeLessThanOrEqual(concurrency);
  });

  it('creates each round trip\'s deadline AFTER acquiring, not at enqueue', async () => {
    // The invisible failure. If the AbortSignal is built when the request is
    // queued rather than when it runs, a request that waited behind others
    // inherits a budget already half spent. Proved structurally rather than by
    // waiting 15 s: signals must be created SERIALLY, interleaved with the
    // fetches, not all up front. (Meaningful at concurrency 1; at higher
    // concurrency the first `concurrency` signals legitimately precede the
    // first completion.)
    const order: string[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.stubGlobal('AbortSignal', Object.assign(Object.create(AbortSignal), {
      timeout: (ms: number) => { order.push('signal'); return realTimeout(ms); },
    }));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 1));
      order.push('fetch');
      return reply(JSON.parse(String(init.body)).input);
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = make();

    await Promise.all(Array.from({ length: concurrency * 3 }, (_, i) => provider.embed(`t${i}`)));

    // No run of signals longer than the concurrency: they are minted as slots
    // free up, not all at submission time.
    const longestSignalRun = order
      .join('')
      .split('fetch')
      .reduce((max, run) => Math.max(max, (run.match(/signal/g) ?? []).length), 0);
    expect(longestSignalRun).toBeLessThanOrEqual(concurrency);
  });
});
