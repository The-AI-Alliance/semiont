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
/** A third live KB. (Was `KB_NODID`, back when a did was optional and the
 *  merge key fell back to the address; identity is now required and the key
 *  is ALWAYS the address — decisions 8 and 9.) */
const KB_NODID: DiscoveredKB = {
  host: 'localhost', port: 4200, placement: 'local', managedBy: 'semiont-launcher',
  did: 'did:web:example.github.io:kb-c',
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

  it('an entry with no did → absent(invalid) with an actionable diagnostic (decision 8)', () => {
    // Identity is required. An older launcher's document can still carry a
    // did-less entry; rejecting the document — rather than skipping that one
    // entry — keeps the never-partially-parse rule, because a filtered subset
    // would silently hide a running KB.
    const legacy = JSON.stringify({
      version: 1,
      kbs: [
        KB_A,
        { host: 'localhost', port: 4300, placement: 'local', managedBy: 'semiont-launcher' },
      ],
    });

    const state = parseDiscoveryDocument(legacy);
    expect(state).toMatchObject({ kind: 'absent', reason: 'invalid' });
    expect(state.kind === 'absent' && state.diagnostic).toContain('did');
    expect(state.kind === 'absent' && state.diagnostic).toContain('launcher');
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
    // `updated` means: SAME address, changed attributes — what lives at this
    // port is not what lived here last poll. (Keyed on the address, a port
    // CHANGE is not an update; see the next test.)
    const renamedA = { ...KB_A, siteName: 'KB A, renamed' };
    const { transport } = scripted([
      { kind: 'managed', kbs: [KB_A, KB_NODID] },
      { kind: 'managed', kbs: [renamedA, KB_NODID, KB_B] },   // A updated in place, B added
      { kind: 'managed', kbs: [KB_B] },                        // A + no-did entry removed
    ]);

    const emitted = await collect(transport, async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(emitted).toHaveLength(3);
    expect(emitted[0]).toMatchObject({ state: { kind: 'managed' }, added: [KB_A, KB_NODID], updated: [], removed: [] });
    expect(emitted[1]).toMatchObject({ added: [KB_B], updated: [renamedA], removed: [] });
    expect(emitted[2]!.added).toEqual([]);
    expect(emitted[2]!.removed).toEqual(expect.arrayContaining([renamedA, KB_NODID]));
  });

  it('a KB that moves port is a removal plus an addition, not an update', async () => {
    // Semantic shift from keying on the address (decision 9): the old
    // binding is DEAD — nothing answers there — and a new one appeared.
    // Calling it an "update" would leave a panel showing a dead address as
    // live. Under the old did-keyed model this was reported as one update.
    const movedA = { ...KB_A, port: 4001 };
    const { transport } = scripted([
      { kind: 'managed', kbs: [KB_A] },
      { kind: 'managed', kbs: [movedA] },
    ]);

    const emitted = await collect(transport, async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ added: [movedA], updated: [], removed: [KB_A] });
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

  /**
   * Decision 9 (KB-IDENTITY-VS-ADDRESS): a did is NOT unique — a local clone
   * and a codespace of the same repo are one KB at two addresses, and BOTH
   * are published. The merge key must therefore be `host:port`, the field
   * the producer guarantees unique (P1); keying on the did collapses the two
   * copies and the diff starts lying about a running stack.
   */
  describe('one KB in two places (decision 9)', () => {
    const CLONE: DiscoveredKB = {
      host: 'localhost', port: 4000, placement: 'local', managedBy: 'semiont-launcher',
      did: 'did:web:example.github.io:kb', siteName: 'KB',
    };
    const CODESPACE: DiscoveredKB = {
      host: 'localhost', port: 4100, placement: 'codespace', managedBy: 'semiont-launcher',
      did: 'did:web:example.github.io:kb', siteName: 'KB', repo: 'octo/kb',
    };

    it('reports no spurious change while both copies are present', async () => {
      const { transport } = scripted([
        { kind: 'managed', kbs: [CLONE, CODESPACE] },
        { kind: 'managed', kbs: [CLONE, CODESPACE] },
      ]);

      const emitted = await collect(transport, async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Initial emission only. Keyed on the did, the second poll's map lookup
      // returns whichever copy won last-wins, so the OTHER copy compares
      // unequal to itself and is reported `updated` on every single poll.
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ added: [CLONE, CODESPACE], updated: [], removed: [] });
    });

    it('reports the removal when one copy stops — the other copy must not mask it', async () => {
      const { transport } = scripted([
        { kind: 'managed', kbs: [CLONE, CODESPACE] },
        { kind: 'managed', kbs: [CLONE] },            // the codespace stopped
      ]);

      const emitted = await collect(transport, async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Keyed on the did, the surviving copy keeps the key present, so the
      // stopped one is never reported gone: the panel would show a dead
      // address indefinitely.
      expect(emitted).toHaveLength(2);
      expect(emitted[1]!.removed).toEqual([CODESPACE]);
      expect(emitted[1]!.added).toEqual([]);
    });

    it('is not a conflict: two copies of one KB warn about nothing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { transport } = scripted([{ kind: 'managed', kbs: [CLONE, CODESPACE] }]);
        await collect(transport, async () => {});
        // Decision 9: same did + different addresses is the COMMON case.
        // Warning here would cry wolf on a normal two-copy setup.
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('a document with two entries sharing a merge key warns instead of silently merging', async () => {
    // KB-IDENTITY-VS-ADDRESS decision 4: ambiguity is shown, never resolved
    // by guessing. Two did-less entries at one address can't both be true,
    // and the diff's Map membership collapses them — say so rather than let
    // a claimant vanish (how the predecessor defect hid for a release).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Same ADDRESS, different dids — the real conflict (only one process
      // binds a port), and the shape the 2026-07-24 live defect had.
      const dupA: DiscoveredKB = { host: 'localhost', port: 4000, placement: 'local', managedBy: 'semiont-launcher', did: 'did:web:example.github.io:kb-a' };
      const dupB: DiscoveredKB = { host: 'localhost', port: 4000, placement: 'codespace', managedBy: 'semiont-launcher', repo: 'octo/other', did: 'did:web:example.github.io:other' };
      const { transport } = scripted([{ kind: 'managed', kbs: [dupA, dupB] }]);

      const emitted = await collect(transport, async () => {});

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('[discovery DUPLICATE]');
      expect(String(warn.mock.calls[0]![0])).toContain('localhost:4000');
      // Both claimants still reach the consumer — nothing is dropped.
      expect(emitted[0]!.state).toMatchObject({ kind: 'managed', kbs: [dupA, dupB] });
    } finally {
      warn.mockRestore();
    }
  });

  it('a well-formed document warns about nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { transport } = scripted([{ kind: 'managed', kbs: [KB_A, KB_B, KB_NODID] }]);
      await collect(transport, async () => {});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
