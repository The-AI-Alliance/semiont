/**
 * A1/A4 — reload fidelity across event arrival.
 * (.plans/bugs/annotation-lost-on-immediate-reload-after-create.md)
 *
 * HISTORY — this file found the fast-path reload loss. Its original model
 * split the C1 suite's atomic `deliver` into `receive` (bookmark stashed)
 * and `apply` (bus handler invalidates), mirroring the PRE-FIX transport,
 * whose read loop stashed `Last-Event-ID` BEFORE the awaited apply fan-out.
 * fast-check shrank the loss to `[receive, writeB]`: in the receive→apply
 * gap nothing is in flight and no save is pending, so `persistencePending()`
 * reported quiet and a bystander document write flushed a bookmark whose
 * event no cache had absorbed. Reload replayed from bookmark+1; the event
 * was never re-delivered; the stale document rendered forever.
 *
 * THE FIX moved the id bookkeeping AFTER the apply fan-out in
 * `actor-state-unit.ts` — an id is stashable only once its event's effects
 * are pending or done — pinned at the transport by the "stashes an id only
 * AFTER the event has been applied" test in `actor-state-unit.test.ts`.
 * Between the apply and the stash only microtasks can interleave; the flush
 * only ever runs inside a macrotask (a debounced save's document write), so
 * the apply→stash pair is atomic with respect to the flush path.
 *
 * THE MODEL HERE therefore has `arrive` = invalidate-then-stash (the
 * guaranteed seam order), and keeps the PRE-FIX ordering expressible as the
 * teeth (`receiveLegacy`/`applyLegacy`) — the suite must still be able to
 * demonstrate the loss it was built to find, so a regression in the
 * transport ordering is caught twice: at the transport pin, and here.
 *
 * Axioms (full statements in the bug doc):
 *   A1  reload fidelity — after reload+replay, rendered state == server truth
 *   A4  rehydrate is never worse than cold
 *
 * NOTE: the rig duplicates `cache-bookmark-coupling.property.test.ts`'s rig
 * (that file predates this one and exports nothing). Fold the rigs together
 * on the next touch of either.
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

function buildRig(storage: InMemorySessionStorage): Rig {
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

  // B17-Q wiring, exactly as the session factory does it.
  coupled.setFlushGate(() => !cacheA.persistencePending() && !cacheB.persistencePending());

  return {
    cacheA, cacheB,
    saveLastEventId: coupled.saveLastEventId,
    resolvers,
    dispose: () => { cacheA.dispose(); cacheB.dispose(); },
  };
}

function persistedAUpTo(storage: InMemorySessionStorage): number {
  const raw = storage.get(A_DOC_KEY);
  if (raw === null) return 0;
  const doc = JSON.parse(raw) as { entries: Array<[string, Content, number]> };
  return doc.entries.find(([k]) => k === KEY)?.[1].upTo ?? 0;
}

function bookmarkSeq(storage: InMemorySessionStorage): number {
  const raw = storage.get(BOOKMARK_KEY);
  if (raw === null) return 0;
  const m = /^p-r1-(\d+)$/.exec(raw);
  if (!m) throw new Error(`unparseable bookmark ${raw}`);
  return Number(m[1]);
}

/**
 * `arrive`        — the FIXED seam: the bus handler invalidates, THEN the id
 *                   is stashed (the order actor-state-unit now guarantees).
 * `receiveLegacy` — TEETH ONLY: the pre-fix stash-before-apply half…
 * `applyLegacy`   — …and its detached apply. Together they reproduce the
 *                   ordering the transport pin outlawed.
 * The remaining commands match the C1 model exactly.
 */
type Command = 'arrive' | 'receiveLegacy' | 'applyLegacy' | 'complete' | 'writeB' | 'settleA';

describe('A1/A4 — reload fidelity across event arrival', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function runScenario(commands: Command[]): Promise<{
    c1Held: boolean;
    renderedEqualsServer: boolean;
    rendered: number;
    serverSeq: number;
  }> {
    const storage = new InMemorySessionStorage();
    let serverSeq = 0;
    let unapplied = 0; // legacy-model events received but not yet applied

    let rig = buildRig(storage);
    // Warm A so a persisted document exists ("the resource was already open").
    rig.cacheA.observe(KEY);
    rig.resolvers.shift()!({ upTo: serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    for (const cmd of commands) {
      switch (cmd) {
        case 'arrive':
          serverSeq += 1;
          rig.cacheA.invalidate(KEY);              // apply first…
          rig.saveLastEventId(`p-r1-${serverSeq}`); // …stash second (the fixed order)
          break;
        case 'receiveLegacy':
          serverSeq += 1;
          unapplied += 1;
          rig.saveLastEventId(`p-r1-${serverSeq}`);
          break;
        case 'applyLegacy':
          if (unapplied > 0) { unapplied -= 1; rig.cacheA.invalidate(KEY); }
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

    const c1Held = persistedAUpTo(storage) >= bookmarkSeq(storage);

    // Reload with crash semantics: the old rig is abandoned un-disposed
    // (a crash flushes nothing), timers die, a fresh rig loads the same
    // storage and resumes.
    vi.clearAllTimers();
    rig = buildRig(storage);
    rig.cacheA.observe(KEY);
    // Replay exists ONLY when a bookmark was persisted. The transport sends
    // `Last-Event-ID` only if it loaded one (`actor-state-unit.ts`: "fresh
    // connections send no header"), and a connect without it gets a
    // live-only stream — the server replays NOTHING. The previous model
    // treated an ABSENT bookmark as "replay from 1", which is backwards and
    // is precisely why this rig was green while the product was broken: it
    // healed every scenario with invalidations the real client never gets.
    // Measured 2026-07-24: at spec-14 failure time there is no lastEventId
    // key in storage at all (the B17-Q gate correctly holds it pending).
    const resumeFrom = storage.get(BOOKMARK_KEY) !== null ? bookmarkSeq(storage) + 1 : null;
    if (resumeFrom !== null) {
      for (let seq = resumeFrom; seq <= serverSeq; seq++) rig.cacheA.invalidate(KEY);
    }
    while (rig.resolvers.length > 0) rig.resolvers.shift()!({ upTo: serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const rendered = rig.cacheA.get(KEY)?.upTo ?? 0;
    rig.dispose();
    return { c1Held, renderedEqualsServer: rendered === serverSeq, rendered, serverSeq };
  }

  /**
   * K5 — now GREEN, and the heart of the fix: the same arrival + bystander
   * write that lost the annotation pre-fix. With apply-before-stash, A is
   * already in flight when the id is stashed, so the bystander's flush
   * attempt finds the gate SHUT; the bookmark lags; replay re-delivers.
   */
  it('K5: arrive → bystander write → crash-reload renders server truth', async () => {
    const r = await runScenario(['arrive', 'writeB']);
    expect(r.c1Held, 'C1: persisted content must not trail the bookmark').toBe(true);
    expect(
      r.renderedEqualsServer,
      `A1: after reload the client rendered upTo=${r.rendered} but server truth is ${r.serverSeq}`,
    ).toBe(true);
  });

  /**
   * TEETH — the pre-fix transport ordering, driven manually. The transport
   * pin in actor-state-unit.test.ts outlaws this order at the seam; this
   * test keeps the loss demonstrable so the suite can never be defanged by
   * a quiet revert of that ordering. If the transport regresses, TWO tests
   * go red: the ordering pin there, and (should anyone then "fix" the pin
   * by deleting it) this one still names the user-visible consequence.
   */
  it('teeth: the pre-fix stash-before-apply ordering still violates C1 (bookmark leads content)', async () => {
    const r = await runScenario(['receiveLegacy', 'writeB', 'applyLegacy']);
    // The storage invariant is still broken by that ordering: the bookmark
    // reaches 1 while the persisted document is still 0.
    expect(r.c1Held).toBe(false);
    // DELIBERATELY NOT asserting a stale render any more. B18
    // (refetch-on-rehydrate) heals the user-visible symptom even when C1 is
    // violated — the reload revalidates and paints server truth regardless
    // of what replay would have delivered. That is the two layers working
    // as intended, not the ordering bug being fixed twice: C1 is the
    // invariant the ordering fix exists to keep true (it still governs
    // keys nothing observes after reload, and cross-resource resumes), and
    // C1 is what this test pins. If B18 were ever removed, the render
    // assertion belongs back here.
  });

  /**
   * K6 — BOUNDARY (green before and after the fix). A bare debounce advance
   * does not flush the stashed bookmark; only an actual cache-document write
   * does. If this reddens, the flush path itself changed.
   */
  it('K6 (boundary, green): arrive → settle → crash-reload renders server truth', async () => {
    const r = await runScenario(['arrive', 'settleA']);
    expect(r.renderedEqualsServer,
      `A1: rendered upTo=${r.rendered}, server truth ${r.serverSeq}`).toBe(true);
  });

  /**
   * A1 as a property over the FIXED seam: no interleaving of arrivals,
   * completions, bystander writes, and settles breaks reload fidelity.
   * This going green (with the teeth red-capable above) is the model-level
   * verdict that apply-before-stash closes the fast path.
   */
  it('A1 property: no interleaving of arrive/complete/writeB/settleA breaks reload fidelity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom<Command>('arrive', 'complete', 'writeB', 'settleA'),
          { maxLength: 12 },
        ),
        async (commands) => {
          const r = await runScenario(commands);
          return r.c1Held && r.renderedEqualsServer;
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * A4 — rehydrate is never worse than cold, on the shape that used to lose.
   * Mechanism-independent: holds any future fix to account.
   */
  it('A4: a rehydrating client renders no worse than a cold one', async () => {
    const commands: Command[] = ['arrive', 'writeB'];
    const warm = await runScenario(commands);

    // Cold baseline: same server truth, empty storage, must fetch.
    const coldStorage = new InMemorySessionStorage();
    const cold = buildRig(coldStorage);
    cold.cacheA.observe(KEY);
    while (cold.resolvers.length > 0) cold.resolvers.shift()!({ upTo: warm.serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const coldRendered = cold.cacheA.get(KEY)?.upTo ?? 0;
    cold.dispose();

    expect(coldRendered, 'cold client is the baseline and must see server truth').toBe(warm.serverSeq);
    expect(
      warm.rendered,
      `A4: rehydrated client rendered ${warm.rendered}, cold client rendered ${coldRendered}`,
    ).toBe(coldRendered);
  });
});
