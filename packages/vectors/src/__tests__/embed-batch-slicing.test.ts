/**
 * `embedBatch` slices, and the timeout bounds ONE round trip.
 *
 * The defect: a flat 15 s deadline covered a whole resource's batch. The smelter
 * hands `embedBatch` every chunk of a resource, so a 721-page book went out as
 * ~1,100 texts in one HTTP request under one `AbortSignal.timeout` — and the
 * timeout did not scale with the work. Measured: three books at ~1,100 chunks;
 * one squeaked in at 15.1 s, two failed at exactly 15 s on every retry, forever,
 * because the batch geometry never changes.
 *
 * So the fix is not a bigger number: it is making the thing the timeout bounds be
 * something it can honestly bound. Slicing alone would be a half-fix, though —
 * more requests with no ceiling on how many are in flight — so each provider also
 * declares its own concurrency and every round trip acquires from one gate held
 * on the provider INSTANCE. A limit inside a call would be multiplied by the
 * number of concurrent callers (the smelter runs a reconcile wave of 8), which is
 * not a cap at all.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaEmbeddingProvider } from '../embedding/ollama';
import { VoyageEmbeddingProvider } from '../embedding/voyage';
import { OLLAMA_BATCH_POLICY } from '../embedding/ollama';
import { VOYAGE_BATCH_POLICY } from '../embedding/voyage';

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
    policy: OLLAMA_BATCH_POLICY,
    make: () => new OllamaEmbeddingProvider({ model: 'nomic-embed-text' }),
    reply: ollamaReply,
  },
  {
    name: 'voyage',
    policy: VOYAGE_BATCH_POLICY,
    make: () => new VoyageEmbeddingProvider({ apiKey: 'k', model: 'voyage-3' }),
    reply: voyageReply,
  },
] as const;

// RED 6: the same table runs against both providers. Fixing one and not the
// other leaves the ceiling in place for the provider that ALSO has a
// request-size limit.
describe.each(providers)('$name', ({ policy, make, reply }) => {
  it('issues ceil(N/sliceSize) calls, each carrying at most sliceSize texts', async () => {
    // RED 1 — geometry. Today: one call carrying all N.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      reply(JSON.parse(String(init.body)).input));
    vi.stubGlobal('fetch', fetchMock);

    const n = policy.sliceSize * 2 + 1;              // deliberately not a multiple
    const texts = Array.from({ length: n }, (_, i) => `t${i}`);

    await make().embedBatch(texts);

    expect(fetchMock).toHaveBeenCalledTimes(Math.ceil(n / policy.sliceSize));
    for (const call of fetchMock.mock.calls) {
      expect(inputsOf(call as [string, RequestInit]).length).toBeLessThanOrEqual(policy.sliceSize);
    }
  });

  it('preserves input order across slices', async () => {
    // RED 3 — the smelter maps embeddings back to chunks POSITIONALLY, so a
    // reordering is silent corruption rather than an error. The stub encodes
    // each input's length in its vector, so the mapping is checkable.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      reply(JSON.parse(String(init.body)).input));
    vi.stubGlobal('fetch', fetchMock);

    // Lengths ascend with index, so the returned vectors must ascend too.
    const texts = Array.from({ length: policy.sliceSize * 2 + 3 }, (_, i) => 'x'.repeat(i + 1));

    const out = await make().embedBatch(texts);

    expect(out).toHaveLength(texts.length);
    expect(out.map((v) => v[0])).toEqual(texts.map((t) => t.length));
  });

  it('a batch far larger than one timeout still succeeds when each slice is fast', async () => {
    // RED 2 — the bug, stated as a test: 1,130 chunks must not fail merely
    // because 1,130 chunks take longer in aggregate than one round trip's budget.
    // Every slice here is fast; only the SUM exceeds a single deadline.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      reply(JSON.parse(String(init.body)).input));
    vi.stubGlobal('fetch', fetchMock);

    const texts = Array.from({ length: 1_130 }, (_, i) => `chunk ${i}`);

    const out = await make().embedBatch(texts);

    expect(out).toHaveLength(1_130);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('never exceeds the provider\'s concurrency, even across concurrent callers', async () => {
    // The cap is on the provider INSTANCE, not the call: two callers sharing a
    // provider share its ceiling. A per-call limiter passes every other test in
    // this file and fails this one — which is the whole point of the gate.
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
    const batch = () => provider.embedBatch(
      Array.from({ length: policy.sliceSize * 3 }, (_, i) => `t${i}`),
    );

    await Promise.all([batch(), batch(), batch()]);

    expect(peak).toBeLessThanOrEqual(policy.concurrency);
  });

  it('a failing slice rejects, naming the slice and the range it covered', async () => {
    // RED 4 — for DIAGNOSIS, not resume: indexing stays all-or-nothing per
    // resource (a partially-indexed resource reads as fresh to reconcile and
    // would never heal). The failure should still say which slice died.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body)).input as string[];
      // Fail only the second slice.
      if (input[0] === `t${policy.sliceSize}`) return new Response('boom', { status: 500 });
      return reply(input);
    });
    vi.stubGlobal('fetch', fetchMock);

    const texts = Array.from({ length: policy.sliceSize * 2 }, (_, i) => `t${i}`);

    await expect(make().embedBatch(texts)).rejects.toMatchObject({
      name: 'EmbeddingProviderError',
      status: 500,
      slice: { index: 1, start: policy.sliceSize, end: policy.sliceSize * 2 },
    });
  });

  it('creates each round trip\'s deadline AFTER acquiring, not at enqueue', async () => {
    // RED 5 — the invisible regression. If the AbortSignal is built when the
    // slice is queued rather than when it runs, a slice that waited behind
    // others inherits a budget already half spent, and the original cliff is
    // rebuilt one layer up. Proved structurally rather than by waiting 15 s:
    // signals must be created SERIALLY, interleaved with the fetches, not all
    // up front. (Meaningful at concurrency 1; at higher concurrency the first
    // `concurrency` signals legitimately precede the first completion.)
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

    await make().embedBatch(Array.from({ length: policy.sliceSize * 3 }, (_, i) => `t${i}`));

    // No run of signals longer than the concurrency: they are minted as slots
    // free up, not all at submission time.
    const longestSignalRun = order
      .join('')
      .split('fetch')
      .reduce((max, run) => Math.max(max, (run.match(/signal/g) ?? []).length), 0);
    expect(longestSignalRun).toBeLessThanOrEqual(policy.concurrency);
  });

  it('embed() of a single text goes through the same gated path', async () => {
    // D3 — every round trip acquires or the cap leaks. `measureDimensions`
    // probes through `embed`, so gating this covers the probe too.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      reply(JSON.parse(String(init.body)).input));
    vi.stubGlobal('fetch', fetchMock);

    const out = await make().embed('solo');

    expect(out).toEqual([4, 0.1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inputsOf(fetchMock.mock.calls[0] as [string, RequestInit])).toEqual(['solo']);
  });
});
