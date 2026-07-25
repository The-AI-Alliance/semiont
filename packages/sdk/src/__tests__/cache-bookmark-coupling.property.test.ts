/**
 * C1 — the persisted bookmark never leads the persisted content.
 * (.plans/bugs/pdf-annotations-vanish-after-reload-stale-persisted-cache.md)
 *
 * For any interleaving of event delivery, refetch completion, debounce
 * advance, bystander-document writes, and reload: if the persisted bookmark
 * is B, every event with id ≤ B has its effect present in the persisted
 * cache documents — and after reload + replay from B+1, rendered state
 * equals server truth.
 *
 * This is the invariant `cache-persister.ts`'s header CLAIMS in prose
 * ("may therefore LAG the caches … but can never lead them") and spec 14
 * measured to be false: doc B's write flushed the stashed bookmark while
 * doc A's content was still mid-refetch or mid-debounce. The V1/V2 append
 * axioms (event-sourcing) hold server-side; the gap is client-side.
 *
 * Everything here is the REAL machinery — InMemorySessionStorage,
 * coupledLastEventId, sessionStoragePersister, createCache — driven by a
 * command interpreter: `deliver` (event arrives: bookmark stashed + cache A
 * invalidated), `complete` (A's oldest in-flight fetch answers with CURRENT
 * server truth — the V1/V2 read-your-writes guarantee), `writeB` (bystander
 * cache B mutates and its save flushes — the flush-trigger of the measured
 * bug), `settleA` (A's debounce fires), `reload` (crash semantics: nothing
 * flushes, fresh rig over the same storage, replay from bookmark+1).
 *
 * RED today by design (real TDD, not a regression fence): the shrunk
 * counterexample is the evidence for whether fix (b) — the quiescence gate —
 * makes the invariant hold, settling by counterexample what the bug doc
 * settles by argument.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createCache, type Cache } from '../cache';
import { coupledLastEventId, sessionStoragePersister } from '../cache-persister';
import { InMemorySessionStorage } from '../session/session-storage';

const KEY = 'res-1';
const A_DOC_KEY = 'semiont.cache.test.annotations';
const B_DOC_KEY = 'semiont.cache.test.entity-types';
const BOOKMARK_KEY = 'semiont.lastEventId.test';
const DEBOUNCE_MS = 50;

/** Content model: "the effect of every event ≤ upTo is present". */
interface Content { upTo: number }

interface Rig {
  cacheA: Cache<string, Content>;
  cacheB: Cache<string, Content>;
  saveLastEventId: (id: string) => void;
  resolvers: Array<(c: Content) => void>;
  dispose: () => void;
}

/** Build a client rig over (shared) storage — mirrors the factory wiring. */
function buildRig(storage: InMemorySessionStorage, opts?: { gated?: boolean }): Rig {
  const coupled = coupledLastEventId(storage, BOOKMARK_KEY);
  const resolvers: Array<(c: Content) => void> = [];

  const cacheA = createCache<string, Content>(
    () => new Promise<Content>((resolve) => { resolvers.push(resolve); }),
    {
      persister: sessionStoragePersister<string, Content>({
        storage: coupled.storage, storageKey: A_DOC_KEY, version: 1,
      }),
      saveDebounceMs: DEBOUNCE_MS,
    },
  );
  const cacheB = createCache<string, Content>(
    async () => ({ upTo: 0 }),
    {
      persister: sessionStoragePersister<string, Content>({
        storage: coupled.storage, storageKey: B_DOC_KEY, version: 1,
      }),
      saveDebounceMs: DEBOUNCE_MS,
    },
  );

  // Fix (b)'s wiring, exactly as the session factory does it: the bookmark
  // may flush only when every persisted cache is quiet.
  if (opts?.gated !== false) {
    coupled.setFlushGate(() => !cacheA.persistencePending() && !cacheB.persistencePending());
  }

  return {
    cacheA, cacheB,
    saveLastEventId: coupled.saveLastEventId,
    resolvers,
    dispose: () => { cacheA.dispose(); cacheB.dispose(); },
  };
}

/** Read the persisted content document for A straight off storage. */
function persistedAUpTo(storage: InMemorySessionStorage): number {
  const raw = storage.get(A_DOC_KEY);
  if (raw === null) return 0;
  const doc = JSON.parse(raw) as { entries: Array<[string, Content, number]> };
  const entry = doc.entries.find(([k]) => k === KEY);
  return entry?.[1].upTo ?? 0;
}

function bookmarkSeq(storage: InMemorySessionStorage): number {
  const raw = storage.get(BOOKMARK_KEY);
  if (raw === null) return 0;
  const m = /^p-r1-(\d+)$/.exec(raw);
  if (!m) throw new Error(`unparseable bookmark ${raw}`);
  return Number(m[1]);
}

type Command = 'deliver' | 'complete' | 'writeB' | 'settleA';

describe('C1 — the persisted bookmark never leads the persisted content', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * Interpret one command sequence, then reload and check both halves of C1.
   * `gated` toggles fix (b) so the property doubles as its own teeth: the
   * ungated rig is the pre-fix implementation and must violate C1 for the
   * counterexample sequences.
   */
  async function runScenario(commands: Command[], gated: boolean): Promise<{
    c1Held: boolean; renderedEqualsServer: boolean;
  }> {
    const storage = new InMemorySessionStorage();
    let serverSeq = 0;

    let rig = buildRig(storage, { gated });
    // Warm A so the persisted doc exists (mirrors "resource was open before").
    rig.cacheA.observe(KEY);
    rig.resolvers.shift()!({ upTo: serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    for (const cmd of commands) {
      switch (cmd) {
        case 'deliver':
          serverSeq += 1;
          rig.saveLastEventId(`p-r1-${serverSeq}`);
          rig.cacheA.invalidate(KEY);
          break;
        case 'complete':
          rig.resolvers.shift()?.({ upTo: serverSeq });
          await vi.advanceTimersByTimeAsync(0);
          break;
        case 'writeB':
          rig.cacheB.set('et', { upTo: serverSeq });
          await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
          break;
        case 'settleA':
          await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
          break;
      }
    }

    // ── C1, first half: at reload time (crash semantics — nothing else
    // flushes), the persisted bookmark must not lead persisted content.
    const c1Held = persistedAUpTo(storage) >= bookmarkSeq(storage);

    // ── Reload: abandon the old rig un-disposed (dispose would flush the
    // pending save — a crash does not), kill its timers, rebuild, replay.
    vi.clearAllTimers();
    rig = buildRig(storage, { gated });
    rig.cacheA.observe(KEY);
    for (let seq = bookmarkSeq(storage) + 1; seq <= serverSeq; seq++) {
      rig.cacheA.invalidate(KEY);   // replay re-invalidates idempotently
    }
    while (rig.resolvers.length > 0) rig.resolvers.shift()!({ upTo: serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // ── C1, corollary (what spec 14 measures): rendered state == server truth.
    const renderedEqualsServer = (rig.cacheA.get(KEY)?.upTo ?? 0) === serverSeq;
    rig.dispose();
    return { c1Held, renderedEqualsServer };
  }

  it('K1 (fix-b keystone): a bystander write while A is mid-refetch does NOT flush the bookmark; the next quiet write does', async () => {
    const storage = new InMemorySessionStorage();
    const rig = buildRig(storage);
    rig.cacheA.observe(KEY);
    rig.resolvers.shift()!({ upTo: 0 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Event 1 arrives: bookmark stashed, A's refetch in flight.
    rig.saveLastEventId('p-r1-1');
    rig.cacheA.invalidate(KEY);

    // Bystander B writes its document — pre-fix this flushed p-r1-1 while
    // A's content was still 0. The gate must hold it back.
    rig.cacheB.set('et', { upTo: 1 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(storage.get(BOOKMARK_KEY)).toBeNull();

    // A completes and its own save fires — everyone quiet — THAT write
    // carries the bookmark through.
    rig.resolvers.shift()!({ upTo: 1 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(storage.get(BOOKMARK_KEY)).toBe('p-r1-1');
    expect(persistedAUpTo(storage)).toBe(1);
    rig.dispose();
  });

  it('K2 (the measured bug, gated): deliver → complete → bystander write → crash-reload renders server truth', async () => {
    const { c1Held, renderedEqualsServer } = await runScenario(
      ['deliver', 'complete', 'writeB'],   // reload lands inside A's debounce window
      true,
    );
    expect(c1Held).toBe(true);
    expect(renderedEqualsServer).toBe(true);
  });

  it('teeth: the UNGATED (pre-fix) rig violates C1 on the measured sequence', async () => {
    // The mid-REFETCH window (A's reply not yet in when B's document write
    // flushes the bookmark). Note `[deliver, complete, writeB]` does NOT
    // violate even ungated: A's own debounced save shares B's deadline and
    // fires first, landing content before the flush — the write-ordering
    // coupling really does cover that narrower path, which is exactly why
    // the bug survived review until spec 14 hit the wider window.
    const { c1Held, renderedEqualsServer } = await runScenario(
      ['deliver', 'writeB'],
      false,
    );
    // Pre-fix: B's write flushes bookmark 1 while A's refetch is still in
    // flight — the persisted doc says 0, the bookmark says 1, replay from 2
    // redelivers nothing, and the reload renders stale. Spec 14's measurement.
    expect(c1Held).toBe(false);
    expect(renderedEqualsServer).toBe(false);
  });

  it('C1 property: no interleaving of deliver/complete/writeB/settleA + crash-reload breaks the invariant (gated)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Command>('deliver', 'complete', 'writeB', 'settleA'), { maxLength: 12 }),
        async (commands) => {
          const { c1Held, renderedEqualsServer } = await runScenario(commands, true);
          if (!c1Held) throw new Error(`C1 violated: bookmark leads persisted content after [${commands.join(', ')}]`);
          if (!renderedEqualsServer) throw new Error(`stale render after reload: [${commands.join(', ')}]`);
        },
      ),
      { numRuns: 60 },
    );
  });
});
