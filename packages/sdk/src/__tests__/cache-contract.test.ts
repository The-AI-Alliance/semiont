/**
 * CACHE-CONTRACT Phases 2–3 — the target contract (.plans/CACHE-CONTRACT.md,
 * D2/D3 settled 2026-07-29).
 *
 * D3 (Phase 2): accessors are LAZY (fetch on first subscribe, never at call
 * time — safe to call from render) and uniformly memoized (per-key identity
 * for the withScope-wrapped accessors too; the un-scoped ones were already
 * stable and stay pinned by entity-types-flow's B4 test).
 *
 * D2 (Phase 3): the thenable is dead; one-shot reads are explicit —
 * `.fresh()` carries the #847 re-read-reflects-writes semantics (fresh
 * fetch, rejects on failure, shares in-flight fetches).
 *
 * Everything runs on the real client over the scriptable transport;
 * `transport.requestLog` is the effect meter.
 */

import { describe, it, expect, vi } from 'vitest';
import { isReady } from '../cache';
import { resourceId as makeResourceId } from '@semiont/core';
import { createTestClient } from '../testing';

const flush = () => new Promise((r) => setTimeout(r, 10));

const RESPONSES = (op: string): unknown => {
  switch (op) {
    case 'browse:entity-types-requested':
      return { entityTypes: ['Person'] };
    case 'browse:resource-requested':
      return { resource: { '@id': 'res-1', name: 'R' } };
    case 'browse:annotations-requested':
      return { annotations: [], total: 0 };
    default:
      return {};
  }
};

describe('D3 — lazy: the fetch belongs to the first subscription, not the call', () => {
  it('calling an accessor issues NO request; first subscribe issues exactly one', async () => {
    const { client, transport } = createTestClient({ transport: { makeResponse: RESPONSES } });

    const obs = client.browse.entityTypes();
    await flush();
    expect(transport.requestLog).toHaveLength(0); // pure call — render-safe

    const values: unknown[] = [];
    const sub = obs.subscribe((v) => {
      if (isReady(v)) values.push(v.value);
    });
    await flush();
    expect(transport.requestLog).toHaveLength(1);
    expect(values).toEqual([['Person']]);

    // A second subscriber joins the cached view — no new request (B2/B4).
    const sub2 = obs.subscribe(() => {});
    await flush();
    expect(transport.requestLog).toHaveLength(1);

    sub.unsubscribe();
    sub2.unsubscribe();
    client.dispose();
  });

  it('scoped accessors are lazy too', async () => {
    const { client, transport } = createTestClient({ transport: { makeResponse: RESPONSES } });
    const rid = makeResourceId('res-1');

    client.browse.resource(rid);
    client.browse.annotations(rid);
    await flush();
    expect(transport.requestLog).toHaveLength(0);

    client.dispose();
  });
});

describe('D3 — uniform identity: per-key, including the withScope-wrapped accessors', () => {
  it('resource()/annotations()/referencedBy()/events() return the SAME observable per key', () => {
    // Calibration history: SDK-DEBT L3 claimed scoped accessors were fresh
    // per call; two recon passes "corrected" it in opposite directions; the
    // Phase-1 pin measured the truth — withScope memoizes per-source
    // (`scopedSources`, #847 Phase 4), so identity was ALREADY uniform and
    // Phase 2 changed only laziness. This test is the standing measurement.
    const { client } = createTestClient({ transport: { makeResponse: RESPONSES } });
    const rid = makeResourceId('res-1');
    const other = makeResourceId('res-2');

    expect(client.browse.resource(rid)).toBe(client.browse.resource(rid));
    expect(client.browse.annotations(rid)).toBe(client.browse.annotations(rid));
    expect(client.browse.referencedBy(rid)).toBe(client.browse.referencedBy(rid));
    expect(client.browse.events(rid)).toBe(client.browse.events(rid));
    // Distinct keys stay distinct.
    expect(client.browse.resource(rid)).not.toBe(client.browse.resource(other));

    client.dispose();
  });
});

describe('D2 — .fresh(): the explicit one-shot read (Phase 3)', () => {
  it('fresh() fetches even when the cache is warm, and resolves the value (#847)', async () => {
    const { client, transport } = createTestClient({ transport: { makeResponse: RESPONSES } });

    const sub = client.browse.entityTypes().subscribe(() => {});
    await flush();
    expect(transport.requestLog).toHaveLength(1);

    const value = await client.browse.entityTypes().fresh();
    expect(value).toEqual(['Person']);
    expect(transport.requestLog).toHaveLength(2);

    sub.unsubscribe();
    client.dispose();
  });

  it('fresh() rejects on failure — the caller owns retry policy (B14 boundary)', async () => {
    const { client } = createTestClient({
      transport: { schedule: [{ kind: 'reject-emit' }], makeResponse: RESPONSES },
    });

    await expect(client.browse.entityTypes().fresh()).rejects.toThrow();
    client.dispose();
  });

  it('the thenable is DEAD: awaiting a live query no longer compiles', async () => {
    const { client } = createTestClient({ transport: { makeResponse: RESPONSES } });

    // The Phase 3 tripwire — compile-time only, deliberately never invoked:
    // if CacheObservable ever grows a `then` again, the @ts-expect-error
    // becomes UNUSED and tsc fails the build.
    const tripwire = () => {
      // @ts-expect-error — CacheObservable is not thenable; use .fresh()
      client.browse.entityTypes().then(() => {});
    };
    void tripwire;

    client.dispose();
  });
});

describe('D1 — the discriminated emission: pending | ready | failed (Phase 4)', () => {
  it('cold key: pending, then ready — the three-outcome truth is in the type', async () => {
    const { client } = createTestClient({ transport: { makeResponse: RESPONSES } });

    const states: Array<string> = [];
    const sub = client.browse.entityTypes().subscribe((s) => states.push(s.status));
    await flush();

    expect(states[0]).toBe('pending');
    expect(states[states.length - 1]).toBe('ready');

    sub.unsubscribe();
    client.dispose();
  });

  it('invalidate keeps ready visible (B7 restated): no pending flash behind a stale value', async () => {
    const { client } = createTestClient({ transport: { makeResponse: RESPONSES } });

    const states: Array<string> = [];
    const sub = client.browse.entityTypes().subscribe((s) => states.push(s.status));
    await flush();
    expect(states[states.length - 1]).toBe('ready');

    const before = states.length;
    client.browse.invalidateEntityTypes();
    await flush();

    // Whatever re-emissions the refetch produced, none were 'pending'.
    expect(states.slice(before)).not.toContain('pending');
    expect(states[states.length - 1]).toBe('ready');

    sub.unsubscribe();
    client.dispose();
  });

  it('exhaustion emits failed — an EMISSION, not a stream death (B15 restated)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = createTestClient({
      transport: { schedule: [{ kind: 'reject-emit' }], makeResponse: RESPONSES },
    });

    const states: Array<{ status: string }> = [];
    let errored = false;
    const sub = client.browse.entityTypes().subscribe({
      next: (s) => states.push(s),
      error: () => {
        errored = true;
      },
    });
    await vi.waitFor(() => expect(states[states.length - 1]!.status).toBe('failed'));

    // The subscription is ALIVE — failure is a state, not a termination.
    expect(errored).toBe(false);
    expect(sub.closed).toBe(false);

    sub.unsubscribe();
    client.dispose();
    warn.mockRestore();
  });

  it('a late subscriber after failure recovers: pending → ready (D3 restated)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, transport } = createTestClient({
      transport: { schedule: [{ kind: 'reject-emit' }, { kind: 'reject-emit' }, { kind: 'deliver' }], makeResponse: RESPONSES },
    });

    const first: string[] = [];
    const sub1 = client.browse.entityTypes().subscribe((s) => first.push(s.status));
    await vi.waitFor(() => expect(first[first.length - 1]).toBe('failed'));
    sub1.unsubscribe();

    const second: string[] = [];
    const sub2 = client.browse.entityTypes().subscribe((s) => second.push(s.status));
    await vi.waitFor(() => expect(second[second.length - 1]).toBe('ready'));
    expect(second[0]).toBe('pending'); // no stale failed replay
    expect(transport.requestLog.length).toBeGreaterThanOrEqual(3);

    sub2.unsubscribe();
    client.dispose();
    warn.mockRestore();
  });
});
