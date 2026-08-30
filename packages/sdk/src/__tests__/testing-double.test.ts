/**
 * Acceptance for `@semiont/sdk/testing` (.plans/SDK-TESTING-DOUBLE.md, Phase 1).
 *
 * The acceptance spec is a deliberate replay of the week's first green-test
 * lie (SDK-DEBT M1): consumers testing against hand-rolled mocks shipped a
 * two-state model of a three-outcome contract. Here the same scenario runs
 * on the REAL cache and REAL busRequest over the scriptable transport —
 * no hand-rolled mock anywhere in this file. The cache's own breadcrumbs
 * ([cache RETRY] / [cache IDLE]) are asserted as proof the real path ran,
 * the same tell that exposed the original lie in
 * list-state.integration.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BusRequestError } from '@semiont/core';
import { createTestClient, createTestSession } from '../testing';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTestClient', () => {
  it('L1 acceptance: entityTypes() through B14 exhaustion surfaces the B15 terminal error on the real cache', async () => {
    // Every reply dropped; the small busTimeoutMs (threaded client → browse)
    // keeps B14's chain in test time. First fetch times out → [cache RETRY]
    // → retry times out → [cache IDLE] + B15 errors the observers.
    const { client } = createTestClient({
      transport: { schedule: [{ kind: 'drop-reply' }] },
      busTimeoutMs: 40,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const states: Array<{ status: string; error?: unknown }> = [];
    const sub = client.browse.entityTypes().subscribe((s) => states.push(s));

    await vi.waitFor(
      () => expect(states[states.length - 1]!.status).toBe('failed'),
      { timeout: 2_000 },
    );

    // Three-outcome contract, third outcome: failed is an EMISSION (D1) —
    // typed, in-stream, and the subscription stays alive.
    expect(states.some((s) => s.status === 'ready')).toBe(false);
    expect(
      (states[states.length - 1] as { error: unknown }).error,
    ).toBeInstanceOf(BusRequestError);

    // The real pathway's own breadcrumbs — a hand-rolled mock cannot fake
    // these into existence.
    const warns = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warns.some((w) => w.includes('[cache RETRY]'))).toBe(true);
    expect(warns.some((w) => w.includes('[cache IDLE]'))).toBe(true);

    sub.unsubscribe();
    client.dispose();
  });

  it('delivers a scripted reply through the real cache when the wire is healthy', async () => {
    const { client, transport } = createTestClient({
      transport: {
        makeResponse: (op) =>
          op === 'browse:entity-types-requested'
            ? { entityTypes: ['Person', 'Place'] }
            : {},
      },
    });

    const values: string[][] = [];
    const sub = client.browse.entityTypes().subscribe((s) => {
      if (s.status === 'ready') values.push(s.value);
    });

    await vi.waitFor(() => expect(values).toHaveLength(1));
    expect(values[0]).toEqual(['Person', 'Place']);

    // The transport handed back is the FaultyTransport itself — its
    // accounting surface is the test's accounting surface.
    expect(transport.requestLog).toHaveLength(1);
    expect(transport.requestLog[0]!.channel).toBe('browse:entity-types-requested');

    sub.unsubscribe();
    client.dispose();
  });
});

describe('createTestSession', () => {
  it('wires a REAL SemiontSession over the same scriptable transport', async () => {
    const { session, client, transport, storage } = createTestSession();

    // Real session, real client, same transport instance — one scripting
    // surface end to end.
    expect(session.client).toBe(client);
    expect(client.transport).toBe(transport);
    expect(typeof session.id).toBe('string');
    expect(session.kb.id).toBeTruthy();

    // No stored token was seeded → the initial validation settles cleanly.
    await session.ready;
    expect(storage.get(`semiont.session.${session.kb.id}`)).toBeNull();

    await session.dispose();
  });
});
