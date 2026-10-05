/**
 * QdrantVectorStore speaks the *query* API, not the removed *search* API.
 *
 * `@qdrant/js-client-rest` 1.19.0 has no `search` or `searchBatch`; the
 * universal `query`/`queryBatch` endpoint supersedes them. A store calling
 * either throws `this.qdrant.searchBatch is not a function` on every vector
 * read, and gather.resource fails outright.
 *
 * Two things would let that reach runtime, and the fake below is built to close
 * both:
 *
 *   1. **A store no test constructs.** A suite covering the memory store only
 *      executes none of these code paths.
 *   2. **A satisfied `tsc`.** Under a `^1.18.0` range a lockfile can resolve
 *      1.18.0, where the removed methods exist, while a *container* resolves
 *      1.19.0: the type-checker and the runtime read different versions of
 *      the client. The dependency is pinned exactly (no range), so the
 *      lockfile, the images, and the launcher's Qdrant server pin
 *      (apps/launcher/internal/launcher/descriptors.go) move together, on
 *      purpose.
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
    // the shape a bare rename from `searchBatch` silently gets wrong.
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
  const store = new QdrantVectorStore({ host: 'localhost', port: 6333, dimensions: async () => 2 });
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
    // The max-sim merge reads `batch.points`; written for an unwrapped array
    // it would iterate the response object itself and yield nothing.
    const store = await connected();

    const results = await store.searchByResource('res-src' as never, { limit: 10 });

    expect(results.map((r) => r.resourceId)).toEqual(expect.arrayContaining(['res-0', 'res-1']));
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[results.length - 1]!.score);
  });

  it('does not consult the embedding provider when the collections already exist', async () => {
    // The fake's getCollection resolves, so both collections are present and
    // nothing needs a vector size. Probing anyway would make a reachable
    // embedding server a precondition of connecting — an eager coupling that
    // breaks CI startup. (Creation still resolves it; that path genuinely
    // needs the size, and `connect()` below never reaches it.)
    const dimensions = vi.fn(async () => 2);
    const store = new QdrantVectorStore({ host: 'localhost', port: 6333, dimensions });

    await store.connect();

    expect(store.isConnected()).toBe(true);
    expect(dimensions).not.toHaveBeenCalled();
  });

  it('over-fetches points per batch, because the merge yields resources', async () => {
    // Each batch's `limit` caps POINTS; the caller's limit counts RESOURCES.
    // At limit-for-limit a target with many chunks fills the slots and crowds
    // out resources that belong in the merged top-N — and the memory store,
    // which scores every candidate, would then out-recall this one. Asking for
    // strictly more than the caller's limit is what keeps the two agreeing.
    const store = await connected();

    await store.searchByResource('res-src' as never, { limit: 10 });

    for (const search of lastBatch!) {
      expect(search.limit as number).toBeGreaterThan(10);
    }
  });

  it('still returns only the caller\'s limit after merging', async () => {
    // Over-fetching must not leak into the result length.
    const store = await connected();

    const results = await store.searchByResource('res-src' as never, { limit: 1 });

    expect(results).toHaveLength(1);
  });
});
