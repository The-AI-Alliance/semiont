/**
 * BROWSER-KB-DISCOVERY P3 — the sdk discovery layer.
 *
 * The SDK owns every semantic: parse + validation (core type guards, no
 * casts), the `version` gate, the TYPED absent-vs-managed distinction, and
 * the poll/diff subscription (keyed `did ?? host:port`). IO is abstracted:
 * `httpDiscovery` (fetch + ETag/304 + the content-type check that makes
 * index.html-at-200 read as absent — the pre-L2a reality) and
 * `textDiscovery(read)` — a consumer-supplied text thunk, the fs-free seam a
 * Node consumer wraps `readFile` in (descoped from the plan's fileDiscovery:
 * no fs in the sdk, user decision 2026-07-21).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DISCOVERY_URL_PATH, type DiscoveredKB } from '@semiont/core';
import {
  parseDiscoveryDocument,
  httpDiscovery,
  textDiscovery,
  subscribeDiscovery,
  type DiscoveryDiff,
  type DiscoveryTransport,
} from '../discovery';

const KB_A: DiscoveredKB = {
  host: 'localhost', port: 4000, placement: 'local', managedBy: 'semiont-launcher',
  did: 'did:web:kb-a.example', siteName: 'KB A',
};
const KB_B: DiscoveredKB = {
  host: 'localhost', port: 4100, placement: 'codespace', managedBy: 'semiont-launcher',
  repo: 'octo/kb-b', did: 'did:web:kb-b.example',
};
/** No did — merge key falls back to host:port. */
const KB_NODID: DiscoveredKB = {
  host: 'localhost', port: 4200, placement: 'local', managedBy: 'semiont-launcher',
};

const doc = (kbs: DiscoveredKB[], version = 1) => JSON.stringify({ version, kbs });

describe('parseDiscoveryDocument — the one validator', () => {
  it('parses a valid document to managed', () => {
    expect(parseDiscoveryDocument(doc([KB_A, KB_B]))).toEqual({ kind: 'managed', kbs: [KB_A, KB_B] });
  });

  it('an empty list is MANAGED, not absent — "launcher manages nothing"', () => {
    expect(parseDiscoveryDocument(doc([]))).toEqual({ kind: 'managed', kbs: [] });
  });

  it('junk text → absent(not-json)', () => {
    expect(parseDiscoveryDocument('<!doctype html><html>…')).toMatchObject({ kind: 'absent', reason: 'not-json' });
  });

  it('unknown version → absent(unsupported-version) with a diagnostic — never a partial parse', () => {
    const state = parseDiscoveryDocument(doc([KB_A], 2));
    expect(state).toMatchObject({ kind: 'absent', reason: 'unsupported-version' });
    expect(state.kind === 'absent' && state.diagnostic).toContain('2');
  });

  it('structurally invalid entries → absent(invalid), not a filtered subset', () => {
    const bad = JSON.stringify({ version: 1, kbs: [{ host: 'localhost' }] }); // missing port/placement/managedBy
    expect(parseDiscoveryDocument(bad)).toMatchObject({ kind: 'absent', reason: 'invalid' });
  });
});

describe('textDiscovery — the IO-abstracted transport', () => {
  it('null from the thunk → absent(not-found)', async () => {
    const t = textDiscovery(async () => null);
    expect(await t.read()).toMatchObject({ kind: 'absent', reason: 'not-found' });
  });

  it('text flows through the one validator', async () => {
    const t = textDiscovery(async () => doc([KB_A]));
    expect(await t.read()).toEqual({ kind: 'managed', kbs: [KB_A] });
  });

  it('a throwing thunk → absent(unreadable) with the error as diagnostic', async () => {
    const t = textDiscovery(async () => { throw new Error('EACCES: permission denied'); });
    const state = await t.read();
    expect(state).toMatchObject({ kind: 'absent', reason: 'unreadable' });
    expect(state.kind === 'absent' && state.diagnostic).toContain('EACCES');
  });
});

describe('httpDiscovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('JSON 200 → managed; the ETag is remembered and 304 short-circuits as unchanged', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(doc([KB_A]), {
        status: 200, headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchSpy);

    const t = httpDiscovery(DISCOVERY_URL_PATH);
    expect(await t.read()).toEqual({ kind: 'managed', kbs: [KB_A] });
    expect(await t.read()).toEqual({ kind: 'unchanged' });

    const secondHeaders = new Headers(fetchSpy.mock.calls[1]![1]?.headers);
    expect(secondHeaders.get('If-None-Match')).toBe('"v1"');
  });

  it('index.html at 200 → absent(not-found) — the pre-L2a SPA fallback reality', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    })));
    expect(await httpDiscovery(DISCOVERY_URL_PATH).read()).toMatchObject({ kind: 'absent', reason: 'not-found' });
  });

  it('404 → absent(not-found)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    expect(await httpDiscovery(DISCOVERY_URL_PATH).read()).toMatchObject({ kind: 'absent', reason: 'not-found' });
  });

  it('a network failure → absent(unreadable), never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await httpDiscovery(DISCOVERY_URL_PATH).read()).toMatchObject({ kind: 'absent', reason: 'unreadable' });
  });
});

describe('subscribeDiscovery — poll + diff, keyed did ?? host:port', () => {
  /** A scriptable transport: each read() shifts the next scripted state. */
  function scripted(states: Array<Awaited<ReturnType<DiscoveryTransport['read']>>>) {
    const reads = vi.fn(async () => states.length > 1 ? states.shift()! : states[0]!);
    return { transport: { read: reads } as DiscoveryTransport, reads };
  }

  async function collect(
    transport: DiscoveryTransport,
    drive: (emitted: DiscoveryDiff[]) => Promise<void>,
  ): Promise<DiscoveryDiff[]> {
    vi.useFakeTimers();
    try {
      const emitted: DiscoveryDiff[] = [];
      const sub = subscribeDiscovery(transport, { intervalMs: 1000 }).subscribe((d) => emitted.push(d));
      await vi.advanceTimersByTimeAsync(0);   // the immediate initial read
      await drive(emitted);
      sub.unsubscribe();
      return emitted;
    } finally {
      vi.useRealTimers();
    }
  }

  it('emits the initial state with every kb as added, then diffs adds/updates/removes', async () => {
    const updatedA = { ...KB_A, port: 4001 };  // same did, new port → updated
    const { transport } = scripted([
      { kind: 'managed', kbs: [KB_A, KB_NODID] },
      { kind: 'managed', kbs: [updatedA, KB_NODID, KB_B] },   // A updated, B added
      { kind: 'managed', kbs: [KB_B] },                        // A + no-did entry removed
    ]);

    const emitted = await collect(transport, async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(emitted).toHaveLength(3);
    expect(emitted[0]).toMatchObject({ state: { kind: 'managed' }, added: [KB_A, KB_NODID], updated: [], removed: [] });
    expect(emitted[1]).toMatchObject({ added: [KB_B], updated: [updatedA], removed: [] });
    expect(emitted[2]!.added).toEqual([]);
    expect(emitted[2]!.removed).toEqual(expect.arrayContaining([expect.objectContaining({ port: 4001 }), KB_NODID]));
  });

  it('unchanged reads and identical re-reads emit nothing', async () => {
    const { transport, reads } = scripted([
      { kind: 'managed', kbs: [KB_A] },
      { kind: 'unchanged' },
      { kind: 'managed', kbs: [KB_A] },   // same content, no 304 (textDiscovery has none)
    ]);

    const emitted = await collect(transport, async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(reads).toHaveBeenCalledTimes(3);
    expect(emitted).toHaveLength(1);      // only the initial emission
  });

  it('absent ↔ managed transitions emit — with removed carrying the entries that vanished', async () => {
    const { transport } = scripted([
      { kind: 'absent', reason: 'not-found' },
      { kind: 'managed', kbs: [KB_A] },
      { kind: 'absent', reason: 'not-found' },   // launcher gone (or pre-L2a fallback returned)
    ]);

    const emitted = await collect(transport, async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(emitted).toHaveLength(3);
    expect(emitted[0]!.state).toMatchObject({ kind: 'absent' });
    expect(emitted[1]).toMatchObject({ state: { kind: 'managed' }, added: [KB_A] });
    expect(emitted[2]).toMatchObject({ state: { kind: 'absent' }, removed: [KB_A] });
  });

  it('unsubscribe stops polling — no further reads fire', async () => {
    const { transport, reads } = scripted([{ kind: 'managed', kbs: [KB_A] }]);
    vi.useFakeTimers();
    try {
      const sub = subscribeDiscovery(transport, { intervalMs: 1000 }).subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const before = reads.mock.calls.length;
      sub.unsubscribe();
      expect(() => sub.unsubscribe()).not.toThrow();   // idempotent
      await vi.advanceTimersByTimeAsync(5000);
      expect(reads.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
