/**
 * QdrantVectorStore speaks the *query* API, not the removed *search* API.
 *
 * `@qdrant/js-client-rest` 1.19.0 deleted `search` and `searchBatch`, which the
 * universal `query`/`queryBatch` endpoint had superseded. This store called
 * both, so on any 1.19.0 install every vector read threw
 * `this.qdrant.searchBatch is not a function` — gather.resource failed outright
 * (observed 2026-08-05 on a live stack).
 *
 * Two things let that reach runtime, and the fake below is built to close both:
 *
 *   1. **No test ever constructed this store.** The suite covered the memory
 *      store only, so nothing executed these code paths at all.
 *   2. **`tsc` was satisfied.** The repo lockfile resolved 1.18.0, where the
 *      removed methods still existed; the *container* resolved 1.19.0 from the
 *      same `^1.18.0` range. The type-checker and the runtime were reading
 *      different versions of the client.
 *
 * So the fake deliberately exposes ONLY the 1.19.0 surface — no `search`, no
 * `searchBatch`. Reintroducing either reproduces the production TypeError here,
 * in milliseconds, without a live Qdrant or a particular installed version.
 * Asserting "we called queryBatch" alone would not do that: it would still pass
 * if someone called `search` somewhere else in the file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];

/** A client shaped like 1.19.0 — the removed methods simply do not exist. */
class FakeQdrantClient {
  async getCollection(name: string) { calls.push(`getCollection:${name}`); return {}; }
  async createCollection() { calls.push('createCollection'); return true; }
  async createPayloadIndex() { calls.push('createPayloadIndex'); return {}; }

  async query(collection: string, body: Record<string, unknown>) {
    calls.push(`query:${collection}`);
    lastQuery = body;
    return { points: [{ id: 'p1', score: 0.9, payload: { resourceId: 'res-2', text: 'hello' } }] };
  }

  async queryBatch(collection: string, body: { searches: Record<string, unknown>[] }) {
    calls.push(`queryBatch:${collection}`);
    lastBatch = body.searches;
    // One response object PER search, each wrapping its hits in `points` —
    // the shape change that a bare rename would have silently got wrong.
    return body.searches.map((_s, i) => ({
      points: [{ id: `p${i}`, score: 0.5 + i / 10, payload: { resourceId: `res-${i}`, text: `t${i}` } }],
    }));
  }

  async scroll(_collection: string, _body: unknown) {
    calls.push('scroll');
    return { points: [{ id: 's1', vector: [0.1, 0.2] }, { id: 's2', vector: [0.3, 0.4] }], next_page_offset: null };
  }
}

let lastQuery: Record<string, unknown> | undefined;
let lastBatch: Record<string, unknown>[] | undefined;

vi.mock('@qdrant/js-client-rest', () => ({ QdrantClient: FakeQdrantClient }));

import { QdrantVectorStore } from '../qdrant';

async function connected() {
  const store = new QdrantVectorStore({ host: 'localhost', port: 6333, dimensions: 2 });
  await store.connect();
  return store;
}

describe('QdrantVectorStore uses the query API', () => {
  beforeEach(() => { calls.length = 0; lastQuery = undefined; lastBatch = undefined; });

  it('connects against a 1.19.0-shaped client', async () => {
    // Guards the connect path too: it also runs client methods, and a removal
    // there would fail every operation rather than just the reads.
    await expect(connected()).resolves.toBeDefined();
  });

  it('searchResources calls query and unwraps `points`', async () => {
    const store = await connected();

    const results = await store.searchResources([0.1, 0.2], { limit: 5 });

    expect(calls).toContain('query:resources');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'p1', resourceId: 'res-2', text: 'hello' });
  });

  it('sends the embedding as `query`, not the removed `vector` field', async () => {
    // The rename is not cosmetic: 1.19.0 ignores an unknown `vector` key, so
    // getting this wrong returns unfiltered nearest-neighbours rather than an
    // error — a silently wrong answer, which is worse than the TypeError.
    const store = await connected();

    await store.searchResources([0.1, 0.2], { limit: 5 });

    expect(lastQuery).toMatchObject({ query: [0.1, 0.2], limit: 5 });
    expect(lastQuery).not.toHaveProperty('vector');
  });

  it('searchByResource calls queryBatch and reads each response`s points', async () => {
    const store = await connected();

    const results = await store.searchByResource('res-src' as never, { limit: 10 });

    expect(calls).toContain('queryBatch:resources');
    // Two scrolled vectors → two searches → two responses, merged and deduped.
    expect(lastBatch).toHaveLength(2);
    expect(lastBatch![0]).toMatchObject({ query: [0.1, 0.2] });
    expect(lastBatch![0]).not.toHaveProperty('vector');
    expect(results.length).toBeGreaterThan(0);
  });

  it('merges batch responses by best score', async () => {
    // The max-sim merge reads `batch.points`; against the old unwrapped array
    // it would iterate the response object itself and yield nothing.
    const store = await connected();

    const results = await store.searchByResource('res-src' as never, { limit: 10 });

    expect(results.map((r) => r.resourceId)).toEqual(expect.arrayContaining(['res-0', 'res-1']));
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[results.length - 1]!.score);
  });
});
